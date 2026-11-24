import type { API, CharacteristicValue, PlatformAccessory, Service, WithUUID } from 'homebridge';
import { DeviceCore } from './deviceCore';
import { Published, Publisher } from './publisher';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings';

interface Context {
  bondId?: string;
  deviceId?: string;
}

/** Publishes devices as HomeKit (HAP) accessories. */
export class HapPublisher implements Publisher {
  readonly label = 'HomeKit';
  readonly cached = new Map<string, PlatformAccessory>();
  private readonly live = new Set<string>();

  constructor(private readonly api: API) {}

  private uuid(bondId: string, deviceId: string): string {
    return this.api.hap.uuid.generate(`bond5m5:${bondId}:${deviceId}`);
  }

  async publish(bondId: string, core: DeviceCore): Promise<Published> {
    const uuid = this.uuid(bondId, core.id);
    let accessory = this.cached.get(uuid);
    const isNew = !accessory;
    if (!accessory) {
      accessory = new this.api.platformAccessory(core.name, uuid);
    }
    accessory.context = { bondId, deviceId: core.id } as Context;
    const acc = accessory;
    this.build(acc, core);
    core.onChange = () => this.show(acc, core);
    if (isNew) {
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [acc]);
      this.cached.set(uuid, acc);
    } else {
      this.api.updatePlatformAccessories([acc]);
    }
    this.live.add(uuid);
    return {
      reconfigure: async () => {
        this.build(acc, core);
        this.api.updatePlatformAccessories([acc]);
      },
      remove: async () => this.drop(uuid),
    };
  }

  private drop(uuid: string): void {
    const accessory = this.cached.get(uuid);
    if (accessory) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.cached.delete(uuid);
    }
    this.live.delete(uuid);
  }

  async removeStale(bondId: string, liveDeviceIds: string[]): Promise<void> {
    for (const [uuid, accessory] of [...this.cached]) {
      const ctx = accessory.context as Context;
      if (ctx.bondId === bondId && !(ctx.deviceId && liveDeviceIds.includes(ctx.deviceId))) {
        this.drop(uuid);
      }
    }
  }

  async removeOrphans(bondIds: string[]): Promise<void> {
    for (const [uuid, accessory] of [...this.cached]) {
      const id = (accessory.context as Context).bondId;
      if (!id || !bondIds.includes(id)) {
        this.drop(uuid);
      }
    }
  }

  async removeAll(): Promise<number> {
    const count = this.cached.size;
    [...this.cached.keys()].forEach(uuid => this.drop(uuid));
    return count;
  }

  private build(acc: PlatformAccessory, core: DeviceCore): void {
    const { Service: S, Characteristic: C } = this.api.hap;
    const hap = this.api.hap;
    const f = core.features;
    acc.displayName = core.name;
    acc.getService(S.AccessoryInformation)!
      .setCharacteristic(C.Manufacturer, 'Bond')
      .setCharacteristic(C.Model, core.device.template || core.device.type || 'Bond device')
      .setCharacteristic(C.SerialNumber, core.id);

    const keep = new Set<Service>();
    const use = (type: WithUUID<typeof Service>, name: string, subtype: string): Service => {
      const svc = acc.getServiceById(type, subtype) ?? acc.addService(type, name, subtype);
      svc.setCharacteristic(C.Name, name);
      keep.add(svc);
      return svc;
    };
    const guard = <T extends CharacteristicValue>(read: () => T) => (): T => {
      if (!core.online) {
        throw new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      }
      return read();
    };
    const optional = (svc: Service, type: Parameters<Service['testCharacteristic']>[0], wanted: boolean): boolean => {
      if (!wanted && svc.testCharacteristic(type)) {
        svc.removeCharacteristic(svc.getCharacteristic(type as never));
      }
      return wanted;
    };

    if (f.fan) {
      const svc = use(S.Fanv2, core.name, 'fan');
      svc.getCharacteristic(C.Active)
        .onGet(guard(() => (core.fanOn() ? C.Active.ACTIVE : C.Active.INACTIVE)))
        .onSet(v => core.wishFan({ active: v === C.Active.ACTIVE }));
      if (optional(svc, C.RotationSpeed, f.speed)) {
        svc.getCharacteristic(C.RotationSpeed)
          .setProps({ minValue: 0, maxValue: 100, minStep: 100 / f.maxSpeed })
          .onSet(v => core.wishSpeedPercent(Number(v)));
      }
      if (optional(svc, C.RotationDirection, f.direction)) {
        svc.getCharacteristic(C.RotationDirection)
          .onSet(v => core.wishFan({ direction: v === C.RotationDirection.COUNTER_CLOCKWISE ? 1 : -1 }));
      }
      if (f.breeze) {
        use(S.Switch, `${core.name} Breeze`, 'breeze').getCharacteristic(C.On).onSet(v => core.setBreeze(v === true));
      }
      for (const hours of f.timers) {
        use(S.Switch, `${core.name} Off in ${hours}h`, `timer-${hours}`)
          .getCharacteristic(C.On).onSet(v => core.setTimer(hours, v === true));
      }
    }
    for (const light of f.lights) {
      const svc = use(S.Lightbulb, light.name, light.part);
      svc.getCharacteristic(C.On)
        .onGet(guard(() => core.lightOn(light.part)))
        .onSet(v => core.wishLight(light.part, { on: v === true }));
      if (optional(svc, C.Brightness, light.dimmable)) {
        svc.getCharacteristic(C.Brightness).onSet(v => core.wishLight(light.part, { brightness: Math.round(Number(v)) }));
      }
    }
    if (f.dimmer) {
      use(S.Switch, `${core.name} Dimmer`, 'dimmer').getCharacteristic(C.On).onSet(v => core.setDimmer(v === true));
    }
    if (f.correct) {
      use(S.Switch, `${core.name} Correct State`, 'correct').getCharacteristic(C.On).onSet(v => core.setCorrecting(v === true));
    }
    for (const svc of [...acc.services]) {
      if (svc.UUID !== S.AccessoryInformation.UUID && !keep.has(svc)) {
        acc.removeService(svc);
      }
    }
    this.show(acc, core);
  }

  private show(acc: PlatformAccessory, core: DeviceCore): void {
    const { Service: S, Characteristic: C } = this.api.hap;
    const f = core.features;
    const fan = acc.getServiceById(S.Fanv2, 'fan');
    if (fan && f.fan) {
      fan.updateCharacteristic(C.Active, core.fanOn() ? C.Active.ACTIVE : C.Active.INACTIVE);
      const percent = core.speedPercent();
      if (f.speed && percent !== undefined) {
        fan.updateCharacteristic(C.RotationSpeed, percent);
      }
      if (f.direction && core.state.direction !== undefined) {
        fan.updateCharacteristic(C.RotationDirection,
          core.reversed() ? C.RotationDirection.CLOCKWISE : C.RotationDirection.COUNTER_CLOCKWISE);
      }
      acc.getServiceById(S.Switch, 'breeze')?.updateCharacteristic(C.On, core.breezeOn());
      for (const hours of f.timers) {
        acc.getServiceById(S.Switch, `timer-${hours}`)?.updateCharacteristic(C.On, core.timerOn(hours));
      }
    }
    for (const light of f.lights) {
      const svc = acc.getServiceById(S.Lightbulb, light.part);
      svc?.updateCharacteristic(C.On, core.lightOn(light.part));
      const level = core.lightLevel(light.part);
      if (svc && light.dimmable && level !== undefined) {
        svc.updateCharacteristic(C.Brightness, level);
      }
    }
    acc.getServiceById(S.Switch, 'dimmer')?.updateCharacteristic(C.On, core.dimming);
    acc.getServiceById(S.Switch, 'correct')?.updateCharacteristic(C.On, core.correcting);
  }
}
