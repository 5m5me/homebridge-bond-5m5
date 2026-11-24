import { DeviceCaps, mapCapabilities } from './capabilities';
import {
  FanWish, LightPart, LightWish, activeTimerHours, breezeIsOn, fanPatch, lightIsOn, lightLevel, lightPatch,
  percentToSpeed, planFan, planLight, speedToPercent,
} from './logic';
import { BondAction, BondDevice, BondState, Logger } from './types';

export interface CoreOptions {
  correctStateSwitch: boolean;
  dimmerSwitch: boolean;
  breezeSwitch: boolean;
  timerHours: number[];
}

export interface CoreDeps {
  log: Logger;
  send(deviceId: string, action: BondAction): Promise<void>;
  patch(deviceId: string, patch: BondState): Promise<void>;
  isOnline(): boolean;
  options: CoreOptions;
}

export interface LightFeature {
  part: LightPart;
  name: string;
  dimmable: boolean;
}

/** What to show for a device, whichever way it is published (HomeKit or Matter). */
export interface Features {
  fan: boolean;
  speed: boolean;
  maxSpeed: number;
  direction: boolean;
  breeze: boolean;
  timers: number[];
  lights: LightFeature[];
  dimmer: boolean;
  correct: boolean;
}

const SETTLE_MS = 80;
const CORRECT_MS = 30000;
const DIMMER_MAX_MS = 15000;

/**
 * One Bond device: what it can do, what the bridge believes about it, and how to command it.
 * Knows nothing about HomeKit or Matter. A publisher shows it and calls back into it.
 */
export class DeviceCore {
  device!: BondDevice;
  caps!: DeviceCaps;
  state: BondState = {};
  correcting = false;
  dimming = false;
  /** Called whenever something a tile shows may have changed. */
  onChange: () => void = () => undefined;
  private fanWish: FanWish = {};
  private fanTimer?: NodeJS.Timeout;
  private lightWish: Partial<Record<LightPart, LightWish>> = {};
  private lightTimer: Partial<Record<LightPart, NodeJS.Timeout>> = {};
  private correctTimer?: NodeJS.Timeout;
  private dimmerTimer?: NodeJS.Timeout;
  private lastTimerHours?: number;

  constructor(device: BondDevice, private readonly deps: CoreDeps) {
    this.setDevice(device);
  }

  setDevice(device: BondDevice): void {
    this.device = device;
    this.caps = mapCapabilities(device);
    this.state = { ...device.state };
  }

  get id(): string {
    return this.device.id;
  }

  get name(): string {
    return this.device.name;
  }

  get online(): boolean {
    return this.deps.isOnline();
  }

  get features(): Features {
    const fan = this.caps.fan;
    const light = this.caps.light;
    const o = this.deps.options;
    const lights: LightFeature[] = !light ? [] : light.kind === 'updown'
      ? [
        { part: 'up', name: `${this.name} Up Light`, dimmable: light.upDownBrightness },
        { part: 'down', name: `${this.name} Down Light`, dimmable: light.upDownBrightness },
      ]
      : [{ part: 'light', name: fan ? `${this.name} Light` : this.name, dimmable: light.brightness }];
    return {
      fan: !!fan,
      speed: !!fan?.speed,
      maxSpeed: fan?.maxSpeed ?? 1,
      direction: !!fan && fan.direction !== 'none',
      breeze: !!fan?.breeze && o.breezeSwitch,
      timers: fan?.timer ? o.timerHours : [],
      lights,
      dimmer: !!light?.dimmer && o.dimmerSwitch,
      correct: o.correctStateSwitch && this.caps.kind !== 'unsupported',
    };
  }

  // What the tiles show.

  fanOn(): boolean {
    return this.state.power === 1 || this.state.power === true;
  }

  /** 0 when off, otherwise the current speed as a percentage. Undefined if on at an unknown speed. */
  speedPercent(): number | undefined {
    if (!this.fanOn()) {
      return 0;
    }
    const speed = Number(this.state.speed);
    return speed > 0 ? speedToPercent(speed, this.features.maxSpeed) : undefined;
  }

  speed(): number {
    return Number(this.state.speed) || 0;
  }

  reversed(): boolean {
    return Number(this.state.direction) === -1;
  }

  breezeOn(): boolean {
    return this.fanOn() && breezeIsOn(this.state);
  }

  timerOn(hours: number): boolean {
    return activeTimerHours(this.state, this.lastTimerHours, this.deps.options.timerHours) === hours;
  }

  lightOn(part: LightPart): boolean {
    return lightIsOn(part, this.state);
  }

  lightLevel(part: LightPart): number | undefined {
    return lightLevel(part, this.state);
  }

  // What the bridge tells us.

  updateState(state: BondState): void {
    this.state = { ...this.state, ...state };
    this.onChange();
  }

  // What Apple Home asks for.

  /** Power, speed and direction often arrive as separate writes. They are collected briefly and sent as one plan. */
  wishFan(wish: FanWish): void {
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

  wishSpeedPercent(percent: number): void {
    this.wishFan({ speed: percentToSpeed(percent, this.features.maxSpeed) });
  }

  wishLight(part: LightPart, wish: LightWish): void {
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

  setBreeze(on: boolean): void {
    this.simple({ name: on ? 'BreezeOn' : 'BreezeOff' }, on ? { breeze: [1], power: 1 } : { breeze: [0] });
  }

  setTimer(hours: number, on: boolean): void {
    this.lastTimerHours = on ? hours : undefined;
    this.simple({ name: 'SetTimer', argument: on ? hours * 3600 : 0 }, { timer: on ? hours * 3600 : 0 });
  }

  setCorrecting(on: boolean): void {
    if (this.correctTimer) {
      clearTimeout(this.correctTimer);
      this.correctTimer = undefined;
    }
    this.correcting = on;
    if (on) {
      this.deps.log.info(`${this.name}: Correct State is on for 30 seconds. Changes update the tile only.`);
      this.correctTimer = setTimeout(() => {
        this.correcting = false;
        this.correctTimer = undefined;
        this.onChange();
      }, CORRECT_MS);
    }
    this.onChange();
  }

  setDimmer(on: boolean): void {
    if (this.dimmerTimer) {
      clearTimeout(this.dimmerTimer);
      this.dimmerTimer = undefined;
    }
    this.dimming = on;
    if (on) {
      this.simple({ name: 'StartDimmer' }, {});
      this.dimmerTimer = setTimeout(() => {
        this.dimmerTimer = undefined;
        this.dimming = false;
        this.simple({ name: 'Stop' }, {});
      }, DIMMER_MAX_MS);
    } else {
      this.simple({ name: 'Stop' }, {});
    }
  }

  stop(): void {
    for (const t of [this.fanTimer, this.correctTimer, this.dimmerTimer, ...Object.values(this.lightTimer)]) {
      if (t) {
        clearTimeout(t);
      }
    }
  }

  private describe(action: BondAction): string {
    return `${action.name}${action.argument === undefined ? '' : ` ${action.argument}`}`;
  }

  private async apply(actions: BondAction[], expected: BondState): Promise<void> {
    try {
      if (this.correcting) {
        if (Object.keys(expected).length) {
          await this.deps.patch(this.id, expected);
          this.deps.log.info(`${this.name}: state corrected to ${JSON.stringify(expected)} (no signal sent)`);
        }
      } else {
        for (const action of actions) {
          await this.deps.send(this.id, action);
          this.deps.log.info(`${this.name}: sent ${this.describe(action)}`);
        }
      }
      this.state = { ...this.state, ...expected };
    } catch (e) {
      this.deps.log.error(`${this.name}: command failed: ${(e as Error).message}`);
    }
    this.onChange();
  }

  /** One command with no planning needed. Always sent, also while Correct State is on. */
  private simple(action: BondAction, expected: BondState): void {
    this.deps.send(this.id, action)
      .then(() => {
        this.deps.log.info(`${this.name}: sent ${this.describe(action)}`);
        this.state = { ...this.state, ...expected };
      })
      .catch(e => this.deps.log.error(`${this.name}: ${action.name} failed: ${(e as Error).message}`))
      .finally(() => this.onChange());
  }
}
