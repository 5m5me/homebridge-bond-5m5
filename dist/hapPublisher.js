"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HapPublisher = void 0;
const settings_1 = require("./settings");
/** Publishes devices as HomeKit (HAP) accessories. */
class HapPublisher {
    api;
    label = 'HomeKit';
    cached = new Map();
    live = new Set();
    constructor(api) {
        this.api = api;
    }
    uuid(bondId, deviceId) {
        return this.api.hap.uuid.generate(`bond5m5:${bondId}:${deviceId}`);
    }
    async publish(bondId, core) {
        const uuid = this.uuid(bondId, core.id);
        let accessory = this.cached.get(uuid);
        const isNew = !accessory;
        if (!accessory) {
            accessory = new this.api.platformAccessory(core.name, uuid);
        }
        accessory.context = { bondId, deviceId: core.id };
        const acc = accessory;
        this.build(acc, core);
        core.onChange = () => this.show(acc, core);
        if (isNew) {
            this.api.registerPlatformAccessories(settings_1.PLUGIN_NAME, settings_1.PLATFORM_NAME, [acc]);
            this.cached.set(uuid, acc);
        }
        else {
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
    drop(uuid) {
        const accessory = this.cached.get(uuid);
        if (accessory) {
            this.api.unregisterPlatformAccessories(settings_1.PLUGIN_NAME, settings_1.PLATFORM_NAME, [accessory]);
            this.cached.delete(uuid);
        }
        this.live.delete(uuid);
    }
    async removeStale(bondId, liveDeviceIds) {
        for (const [uuid, accessory] of [...this.cached]) {
            const ctx = accessory.context;
            if (ctx.bondId === bondId && !(ctx.deviceId && liveDeviceIds.includes(ctx.deviceId))) {
                this.drop(uuid);
            }
        }
    }
    async removeOrphans(bondIds) {
        for (const [uuid, accessory] of [...this.cached]) {
            const id = accessory.context.bondId;
            if (!id || !bondIds.includes(id)) {
                this.drop(uuid);
            }
        }
    }
    async removeAll() {
        const count = this.cached.size;
        [...this.cached.keys()].forEach(uuid => this.drop(uuid));
        return count;
    }
    build(acc, core) {
        const { Service: S, Characteristic: C } = this.api.hap;
        const hap = this.api.hap;
        const f = core.features;
        acc.displayName = core.name;
        acc.getService(S.AccessoryInformation)
            .setCharacteristic(C.Manufacturer, 'Bond')
            .setCharacteristic(C.Model, core.device.template || core.device.type || 'Bond device')
            .setCharacteristic(C.SerialNumber, core.id);
        const keep = new Set();
        const use = (type, name, subtype) => {
            const svc = acc.getServiceById(type, subtype) ?? acc.addService(type, name, subtype);
            svc.setCharacteristic(C.Name, name);
            keep.add(svc);
            return svc;
        };
        const guard = (read) => () => {
            if (!core.online) {
                throw new hap.HapStatusError(-70402 /* hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE */);
            }
            return read();
        };
        const optional = (svc, type, wanted) => {
            if (!wanted && svc.testCharacteristic(type)) {
                svc.removeCharacteristic(svc.getCharacteristic(type));
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
    show(acc, core) {
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
                fan.updateCharacteristic(C.RotationDirection, core.reversed() ? C.RotationDirection.CLOCKWISE : C.RotationDirection.COUNTER_CLOCKWISE);
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
exports.HapPublisher = HapPublisher;
