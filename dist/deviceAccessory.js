"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BondDeviceAccessory = void 0;
const capabilities_1 = require("./capabilities");
const logic_1 = require("./logic");
const SETTLE_MS = 80;
const CORRECT_MS = 30000;
const DIMMER_MAX_MS = 15000;
/** One Bond device shown in Apple Home. Builds its tiles from what the bridge says it can do. */
class BondDeviceAccessory {
    accessory;
    deps;
    device;
    caps;
    state = {};
    fanWish = {};
    fanTimer;
    lightWish = {};
    lightTimer = {};
    correctTimer;
    dimmerTimer;
    correcting = false;
    constructor(accessory, device, deps) {
        this.accessory = accessory;
        this.deps = deps;
        this.configure(device);
    }
    get deviceId() {
        return this.device.id;
    }
    get hap() {
        return this.deps.api.hap;
    }
    /** Builds or rebuilds the services. Safe to call again when the device changes in the Bond app. */
    configure(device) {
        this.device = device;
        this.caps = (0, capabilities_1.mapCapabilities)(device);
        this.state = { ...device.state };
        const { Service: S, Characteristic: C } = this.hap;
        const acc = this.accessory;
        acc.displayName = device.name;
        acc.getService(S.AccessoryInformation)
            .setCharacteristic(C.Manufacturer, 'Bond')
            .setCharacteristic(C.Model, device.template || device.type || 'Bond device')
            .setCharacteristic(C.SerialNumber, device.id);
        const keep = new Set();
        const use = (type, name, subtype) => {
            const svc = acc.getServiceById(type, subtype) ?? acc.addService(type, name, subtype);
            svc.setCharacteristic(C.Name, name);
            keep.add(svc);
            return svc;
        };
        const guard = (read) => () => {
            if (!this.deps.isOnline()) {
                throw new this.hap.HapStatusError(-70402 /* this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE */);
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
                    .onSet(v => this.wishFan({ speed: (0, logic_1.percentToSpeed)(Number(v), fan.maxSpeed) }));
            }
            else if (svc.testCharacteristic(C.RotationSpeed)) {
                svc.removeCharacteristic(svc.getCharacteristic(C.RotationSpeed));
            }
            if (fan.direction !== 'none') {
                svc.getCharacteristic(C.RotationDirection)
                    .onSet(v => this.wishFan({ direction: v === C.RotationDirection.COUNTER_CLOCKWISE ? 1 : -1 }));
            }
            else if (svc.testCharacteristic(C.RotationDirection)) {
                svc.removeCharacteristic(svc.getCharacteristic(C.RotationDirection));
            }
        }
        if (this.caps.light) {
            const light = this.caps.light;
            const parts = light.kind === 'updown'
                ? [['up', `${device.name} Up Light`, light.upDownBrightness], ['down', `${device.name} Down Light`, light.upDownBrightness]]
                : [['light', this.caps.fan ? `${device.name} Light` : device.name, light.brightness]];
            for (const [part, name, dimmable] of parts) {
                const svc = use(S.Lightbulb, name, part);
                svc.getCharacteristic(C.On)
                    .onGet(guard(() => (0, logic_1.lightIsOn)(part, this.state)))
                    .onSet(v => this.wishLight(part, { on: v === true }));
                if (dimmable) {
                    svc.getCharacteristic(C.Brightness)
                        .onSet(v => this.wishLight(part, { brightness: Math.round(Number(v)) }));
                }
                else if (svc.testCharacteristic(C.Brightness)) {
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
    updateState(state) {
        this.state = { ...this.state, ...state };
        this.publish();
    }
    /** Shows the tiles as reachable or not by re-reading the values. */
    refresh() {
        this.publish();
    }
    stop() {
        for (const t of [this.fanTimer, this.correctTimer, this.dimmerTimer, ...Object.values(this.lightTimer)]) {
            if (t) {
                clearTimeout(t);
            }
        }
    }
    fanOn() {
        return this.state.power === 1 || this.state.power === true;
    }
    publish() {
        const { Service: S, Characteristic: C } = this.hap;
        const acc = this.accessory;
        const fanSvc = acc.getServiceById(S.Fanv2, 'fan');
        if (fanSvc && this.caps.fan) {
            const on = this.fanOn();
            fanSvc.updateCharacteristic(C.Active, on ? C.Active.ACTIVE : C.Active.INACTIVE);
            if (this.caps.fan.speed) {
                const speed = Number(this.state.speed);
                if (on && speed > 0) {
                    fanSvc.updateCharacteristic(C.RotationSpeed, (0, logic_1.speedToPercent)(speed, this.caps.fan.maxSpeed));
                }
                else if (!on) {
                    fanSvc.updateCharacteristic(C.RotationSpeed, 0);
                }
            }
            if (this.caps.fan.direction !== 'none' && this.state.direction !== undefined) {
                fanSvc.updateCharacteristic(C.RotationDirection, Number(this.state.direction) === -1 ? C.RotationDirection.CLOCKWISE : C.RotationDirection.COUNTER_CLOCKWISE);
            }
        }
        for (const part of ['light', 'up', 'down']) {
            const svc = acc.getServiceById(S.Lightbulb, part);
            if (!svc) {
                continue;
            }
            svc.updateCharacteristic(C.On, (0, logic_1.lightIsOn)(part, this.state));
            const level = (0, logic_1.lightLevel)(part, this.state);
            if (level !== undefined && svc.testCharacteristic(C.Brightness)) {
                svc.updateCharacteristic(C.Brightness, level);
            }
        }
    }
    // Apple Home often sends power and speed as two separate writes. Collect them briefly, then act once.
    wishFan(wish) {
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
                void this.apply((0, logic_1.planFan)(w, this.state, fan), (0, logic_1.fanPatch)(w, fan));
            }
        }, SETTLE_MS);
    }
    wishLight(part, wish) {
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
                void this.apply((0, logic_1.planLight)(part, w, this.state, light), (0, logic_1.lightPatch)(part, w, light));
            }
        }, SETTLE_MS);
    }
    async apply(actions, expected) {
        const name = this.device.name;
        try {
            if (this.correcting) {
                if (Object.keys(expected).length) {
                    await this.deps.patch(this.device.id, expected);
                    this.deps.log.info(`${name}: state corrected to ${JSON.stringify(expected)} (no signal sent)`);
                }
            }
            else {
                for (const action of actions) {
                    await this.deps.send(this.device.id, action);
                    this.deps.log.info(`${name}: sent ${action.name}${action.argument === undefined ? '' : ` ${action.argument}`}`);
                }
            }
            this.state = { ...this.state, ...expected };
        }
        catch (e) {
            this.deps.log.error(`${name}: command failed: ${e.message}`);
        }
        this.publish();
    }
    setCorrecting(on, svc) {
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
    setDimmer(on, svc) {
        if (this.dimmerTimer) {
            clearTimeout(this.dimmerTimer);
            this.dimmerTimer = undefined;
        }
        const send = (action) => {
            this.deps.send(this.device.id, { name: action })
                .then(() => this.deps.log.info(`${this.device.name}: sent ${action}`))
                .catch(e => this.deps.log.error(`${this.device.name}: ${action} failed: ${e.message}`));
        };
        if (on) {
            send('StartDimmer');
            this.dimmerTimer = setTimeout(() => {
                this.dimmerTimer = undefined;
                send('Stop');
                svc.updateCharacteristic(this.hap.Characteristic.On, false);
            }, DIMMER_MAX_MS);
        }
        else {
            send('Stop');
        }
    }
}
exports.BondDeviceAccessory = BondDeviceAccessory;
