import type { API, CharacteristicValue, PlatformAccessory, Service, WithUUID } from 'homebridge';
import { DeviceCaps, mapCapabilities } from './capabilities';
import {
  FanWish, LightPart, LightWish, activeTimerHours, breezeIsOn, fanPatch, lightIsOn, lightLevel, lightPatch,
  percentToSpeed, planFan, planLight, speedToPercent,
} from './logic';
import { BondAction, BondDevice, BondState, Logger } from './types';

export interface AccessoryDeps {
  api: API;
  log: Logger;
  send(deviceId: string, action: BondAction): Promise<void>;
  patch(deviceId: string, patch: BondState): Promise<void>;
  isOnline(): boolean;
  correctStateSwitch: boolean;
  dimmerSwitch: boolean;
  breezeSwitch: boolean;
  timerHours: number[];
}

const SETTLE_MS = 80;
const CORRECT_MS = 30000;
const DIMMER_MAX_MS = 15000;

/** One Bond device shown in Apple Home. Builds its tiles from what the bridge says it can do. */
export class BondDeviceAccessory {
  private device!: BondDevice;
  private caps!: DeviceCaps;
  private state: BondState = {};
  private fanWish: FanWish = {};
  private fanTimer?: NodeJS.Timeout;
  private lightWish: Partial<Record<LightPart, LightWish>> = {};
  private lightTimer: Partial<Record<LightPart, NodeJS.Timeout>> = {};
  private correctTimer?: NodeJS.Timeout;
  private dimmerTimer?: NodeJS.Timeout;
  private correcting = false;
  private lastTimerHours?: number;

  constructor(readonly accessory: PlatformAccessory, device: BondDevice, private readonly deps: AccessoryDeps) {
    this.configure(device);
  }

  get deviceId(): string {
    return this.device.id;
  }

  private get hap(): API['hap'] {
    return this.deps.api.hap;
  }

  /** Builds or rebuilds the services. Safe to call again when the device changes in the Bond app. */
  configure(device: BondDevice): void {
    this.device = device;
    this.caps = mapCapabilities(device);
    this.state = { ...device.state };
    const { Service: S, Characteristic: C } = this.hap;
    const acc = this.accessory;
    acc.displayName = device.name;
    acc.getService(S.AccessoryInformation)!
      .setCharacteristic(C.Manufacturer, 'Bond')
      .setCharacteristic(C.Model, device.template || device.type || 'Bond device')
      .setCharacteristic(C.SerialNumber, device.id);

    const keep = new Set<Service>();
    const use = (type: WithUUID<typeof Service>, name: string, subtype: string): Service => {
      const svc = acc.getServiceById(type, subtype) ?? acc.addService(type, name, subtype);
      svc.setCharacteristic(C.Name, name);
      keep.add(svc);
      return svc;
    };
    const guard = <T extends CharacteristicValue>(read: () => T) => (): T => {
      if (!this.deps.isOnline()) {
        throw new this.hap.HapStatusError(this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      }
      return read();
    };

    if (this.caps.fan) {
      const fan = this.caps.fan;
      const svc = use(S.Fanv2, device.name, 'fan');
      svc.getCharacteristic(C.Active)
        .onGet(guard(() => (this.fanOn() ? C.Active.ACTIVE : C.Active.INACTIVE)))
        .onSet(v => this.wishFan({ active: v === C.Active.ACTIVE }));
      if (fan.speed) {
        svc.getCharacteristic(C.RotationSpeed)
          .setProps({ minValue: 0, maxValue: 100, minStep: 100 / fan.maxSpeed })
          .onSet(v => this.wishFan({ speed: percentToSpeed(Number(v), fan.maxSpeed) }));
      } else if (svc.testCharacteristic(C.RotationSpeed)) {
        svc.removeCharacteristic(svc.getCharacteristic(C.RotationSpeed));
      }
      if (fan.direction !== 'none') {
        svc.getCharacteristic(C.RotationDirection)
          .onSet(v => this.wishFan({ direction: v === C.RotationDirection.COUNTER_CLOCKWISE ? 1 : -1 }));
      } else if (svc.testCharacteristic(C.RotationDirection)) {
        svc.removeCharacteristic(svc.getCharacteristic(C.RotationDirection));
      }
      if (fan.breeze && this.deps.breezeSwitch) {
        const sw = use(S.Switch, `${device.name} Breeze`, 'breeze');
        sw.getCharacteristic(C.On).onSet(v => this.simple(
          { name: v === true ? 'BreezeOn' : 'BreezeOff' }, v === true ? { breeze: [1], power: 1 } : { breeze: [0] }));
      }
      if (fan.timer) {
        for (const hours of this.deps.timerHours) {
          const sw = use(S.Switch, `${device.name} Off in ${hours}h`, `timer-${hours}`);
          sw.getCharacteristic(C.On).onSet(v => {
            this.lastTimerHours = v === true ? hours : undefined;
            this.simple({ name: 'SetTimer', argument: v === true ? hours * 3600 : 0 }, { timer: v === true ? hours * 3600 : 0 });
          });
        }
      }
    }

    if (this.caps.light) {
      const light = this.caps.light;
      const parts: Array<[LightPart, string, boolean]> = light.kind === 'updown'
        ? [['up', `${device.name} Up Light`, light.upDownBrightness], ['down', `${device.name} Down Light`, light.upDownBrightness]]
        : [['light', this.caps.fan ? `${device.name} Light` : device.name, light.brightness]];
      for (const [part, name, dimmable] of parts) {
        const svc = use(S.Lightbulb, name, part);
        svc.getCharacteristic(C.On)
          .onGet(guard(() => lightIsOn(part, this.state)))
          .onSet(v => this.wishLight(part, { on: v === true }));
        if (dimmable) {
          svc.getCharacteristic(C.Brightness)
            .onSet(v => this.wishLight(part, { brightness: Math.round(Number(v)) }));
        } else if (svc.testCharacteristic(C.Brightness)) {
          svc.removeCharacteristic(svc.getCharacteristic(C.Brightness));
        }
      }
      if (light.dimmer && this.deps.dimmerSwitch) {
        const svc = use(S.Switch, `${device.name} Dimmer`, 'dimmer');
        svc.getCharacteristic(C.On).onSet(v => this.setDimmer(v === true, svc));
        svc.updateCharacteristic(C.On, false);
      }
    }

    if (this.deps.correctStateSwitch && this.caps.kind !== 'unsupported') {
      const svc = use(S.Switch, `${device.name} Correct State`, 'correct');
      svc.getCharacteristic(C.On).onSet(v => this.setCorrecting(v === true, svc));
      svc.updateCharacteristic(C.On, false);
    }

    for (const svc of [...acc.services]) {
      if (svc.UUID !== S.AccessoryInformation.UUID && !keep.has(svc)) {
        acc.removeService(svc);
      }
    }
    this.publish();
  }

  /** New state from the bridge (push or poll). */
  updateState(state: BondState): void {
    this.state = { ...this.state, ...state };
    this.publish();
  }

  /** Shows the tiles as reachable or not by re-reading the values. */
  refresh(): void {
    this.publish();
  }

  stop(): void {
    for (const t of [this.fanTimer, this.correctTimer, this.dimmerTimer, ...Object.values(this.lightTimer)]) {
      if (t) {
        clearTimeout(t);
      }
    }
  }

  private fanOn(): boolean {
    return this.state.power === 1 || this.state.power === true;
  }

  private publish(): void {
    const { Service: S, Characteristic: C } = this.hap;
    const acc = this.accessory;
    const fanSvc = acc.getServiceById(S.Fanv2, 'fan');
    if (fanSvc && this.caps.fan) {
      const on = this.fanOn();
      fanSvc.updateCharacteristic(C.Active, on ? C.Active.ACTIVE : C.Active.INACTIVE);
      if (this.caps.fan.speed) {
        const speed = Number(this.state.speed);
        if (on && speed > 0) {
          fanSvc.updateCharacteristic(C.RotationSpeed, speedToPercent(speed, this.caps.fan.maxSpeed));
        } else if (!on) {
          fanSvc.updateCharacteristic(C.RotationSpeed, 0);
        }
      }
      if (this.caps.fan.direction !== 'none' && this.state.direction !== undefined) {
        fanSvc.updateCharacteristic(C.RotationDirection,
          Number(this.state.direction) === -1 ? C.RotationDirection.CLOCKWISE : C.RotationDirection.COUNTER_CLOCKWISE);
      }
    }
    if (this.caps.fan) {
      acc.getServiceById(S.Switch, 'breeze')?.updateCharacteristic(C.On, this.fanOn() && breezeIsOn(this.state));
      const active = activeTimerHours(this.state, this.lastTimerHours, this.deps.timerHours);
      for (const hours of this.deps.timerHours) {
        acc.getServiceById(S.Switch, `timer-${hours}`)?.updateCharacteristic(C.On, active === hours);
      }
    }
    for (const part of ['light', 'up', 'down'] as LightPart[]) {
      const svc = acc.getServiceById(S.Lightbulb, part);
      if (!svc) {
        continue;
      }
      svc.updateCharacteristic(C.On, lightIsOn(part, this.state));
      const level = lightLevel(part, this.state);
      if (level !== undefined && svc.testCharacteristic(C.Brightness)) {
        svc.updateCharacteristic(C.Brightness, level);
      }
    }
  }

  // Apple Home often sends power and speed as two separate writes. Collect them briefly, then act once.
  private wishFan(wish: FanWish): void {
    this.fanWish = { ...this.fanWish, ...wish };
    if (this.fanTimer) {
      clearTimeout(this.fanTimer);
    }
    this.fanTimer = setTimeout(() => {
      const w = this.fanWish;
      this.fanWish = {};
      this.fanTimer = undefined;
      const fan = this.caps.fan;
      if (fan) {
        void this.apply(planFan(w, this.state, fan), fanPatch(w, fan));
      }
    }, SETTLE_MS);
  }

  private wishLight(part: LightPart, wish: LightWish): void {
    this.lightWish[part] = { ...this.lightWish[part], ...wish };
    const pending = this.lightTimer[part];
    if (pending) {
      clearTimeout(pending);
    }
    this.lightTimer[part] = setTimeout(() => {
      const w = this.lightWish[part] ?? {};
      delete this.lightWish[part];
      delete this.lightTimer[part];
      const light = this.caps.light;
      if (light) {
        void this.apply(planLight(part, w, this.state, light), lightPatch(part, w, light));
      }
    }, SETTLE_MS);
  }

  private async apply(actions: BondAction[], expected: BondState): Promise<void> {
    const name = this.device.name;
    try {
      if (this.correcting) {
        if (Object.keys(expected).length) {
          await this.deps.patch(this.device.id, expected);
          this.deps.log.info(`${name}: state corrected to ${JSON.stringify(expected)} (no signal sent)`);
        }
      } else {
        for (const action of actions) {
          await this.deps.send(this.device.id, action);
          this.deps.log.info(`${name}: sent ${action.name}${action.argument === undefined ? '' : ` ${action.argument}`}`);
        }
      }
      this.state = { ...this.state, ...expected };
    } catch (e) {
      this.deps.log.error(`${name}: command failed: ${(e as Error).message}`);
    }
    this.publish();
  }

  /** One command with no planning needed. Always sent, also while Correct State is on. */
  private simple(action: BondAction, expected: BondState): void {
    this.deps.send(this.device.id, action)
      .then(() => {
        this.deps.log.info(`${this.device.name}: sent ${action.name}${action.argument === undefined ? '' : ` ${action.argument}`}`);
        this.state = { ...this.state, ...expected };
      })
      .catch(e => this.deps.log.error(`${this.device.name}: ${action.name} failed: ${(e as Error).message}`))
      .finally(() => this.publish());
  }

  private setCorrecting(on: boolean, svc: Service): void {
    if (this.correctTimer) {
      clearTimeout(this.correctTimer);
      this.correctTimer = undefined;
    }
    this.correcting = on;
    if (on) {
      this.deps.log.info(`${this.device.name}: Correct State is on for 30 seconds. Changes update the tile only.`);
      this.correctTimer = setTimeout(() => {
        this.correcting = false;
        this.correctTimer = undefined;
        svc.updateCharacteristic(this.hap.Characteristic.On, false);
      }, CORRECT_MS);
    }
  }

  private setDimmer(on: boolean, svc: Service): void {
    if (this.dimmerTimer) {
      clearTimeout(this.dimmerTimer);
      this.dimmerTimer = undefined;
    }
    const send = (action: string): void => {
      this.deps.send(this.device.id, { name: action })
        .then(() => this.deps.log.info(`${this.device.name}: sent ${action}`))
        .catch(e => this.deps.log.error(`${this.device.name}: ${action} failed: ${(e as Error).message}`));
    };
    if (on) {
      send('StartDimmer');
      this.dimmerTimer = setTimeout(() => {
        this.dimmerTimer = undefined;
        send('Stop');
        svc.updateCharacteristic(this.hap.Characteristic.On, false);
      }, DIMMER_MAX_MS);
    } else {
      send('Stop');
    }
  }
}
