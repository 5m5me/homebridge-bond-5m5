"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DeviceCore = void 0;
const capabilities_1 = require("./capabilities");
const logic_1 = require("./logic");
const SETTLE_MS = 80;
const CORRECT_MS = 30000;
const DIMMER_MAX_MS = 15000;
/**
 * One Bond device: what it can do, what the bridge believes about it, and how to command it.
 * Knows nothing about HomeKit or Matter. A publisher shows it and calls back into it.
 */
class DeviceCore {
    deps;
    device;
    caps;
    state = {};
    correcting = false;
    dimming = false;
    /** Called whenever something a tile shows may have changed. */
    onChange = () => undefined;
    fanWish = {};
    fanTimer;
    lightWish = {};
    lightTimer = {};
    correctTimer;
    dimmerTimer;
    lastTimerHours;
    constructor(device, deps) {
        this.deps = deps;
        this.setDevice(device);
    }
    setDevice(device) {
        this.device = device;
        this.caps = (0, capabilities_1.mapCapabilities)(device);
        this.state = { ...device.state };
    }
    get id() {
        return this.device.id;
    }
    get name() {
        return this.device.name;
    }
    get online() {
        return this.deps.isOnline();
    }
    get features() {
        const fan = this.caps.fan;
        const light = this.caps.light;
        const o = this.deps.options;
        const lights = !light ? [] : light.kind === 'updown'
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
    fanOn() {
        return this.state.power === 1 || this.state.power === true;
    }
    /** 0 when off, otherwise the current speed as a percentage. Undefined if on at an unknown speed. */
    speedPercent() {
        if (!this.fanOn()) {
            return 0;
        }
        const speed = Number(this.state.speed);
        return speed > 0 ? (0, logic_1.speedToPercent)(speed, this.features.maxSpeed) : undefined;
    }
    speed() {
        return Number(this.state.speed) || 0;
    }
    reversed() {
        return Number(this.state.direction) === -1;
    }
    breezeOn() {
        return this.fanOn() && (0, logic_1.breezeIsOn)(this.state);
    }
    timerOn(hours) {
        return (0, logic_1.activeTimerHours)(this.state, this.lastTimerHours, this.deps.options.timerHours) === hours;
    }
    lightOn(part) {
        return (0, logic_1.lightIsOn)(part, this.state);
    }
    lightLevel(part) {
        return (0, logic_1.lightLevel)(part, this.state);
    }
    // What the bridge tells us.
    updateState(state) {
        this.state = { ...this.state, ...state };
        this.onChange();
    }
    // What Apple Home asks for.
    /** Power, speed and direction often arrive as separate writes. They are collected briefly and sent as one plan. */
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
    wishSpeedPercent(percent) {
        this.wishFan({ speed: (0, logic_1.percentToSpeed)(percent, this.features.maxSpeed) });
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
    setBreeze(on) {
        this.simple({ name: on ? 'BreezeOn' : 'BreezeOff' }, on ? { breeze: [1], power: 1 } : { breeze: [0] });
    }
    setTimer(hours, on) {
        this.lastTimerHours = on ? hours : undefined;
        this.simple({ name: 'SetTimer', argument: on ? hours * 3600 : 0 }, { timer: on ? hours * 3600 : 0 });
    }
    setCorrecting(on) {
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
    setDimmer(on) {
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
        }
        else {
            this.simple({ name: 'Stop' }, {});
        }
    }
    stop() {
        for (const t of [this.fanTimer, this.correctTimer, this.dimmerTimer, ...Object.values(this.lightTimer)]) {
            if (t) {
                clearTimeout(t);
            }
        }
    }
    describe(action) {
        return `${action.name}${action.argument === undefined ? '' : ` ${action.argument}`}`;
    }
    async apply(actions, expected) {
        try {
            if (this.correcting) {
                if (Object.keys(expected).length) {
                    await this.deps.patch(this.id, expected);
                    this.deps.log.info(`${this.name}: state corrected to ${JSON.stringify(expected)} (no signal sent)`);
                }
            }
            else {
                for (const action of actions) {
                    await this.deps.send(this.id, action);
                    this.deps.log.info(`${this.name}: sent ${this.describe(action)}`);
                }
            }
            this.state = { ...this.state, ...expected };
        }
        catch (e) {
            this.deps.log.error(`${this.name}: command failed: ${e.message}`);
        }
        this.onChange();
    }
    /** One command with no planning needed. Always sent, also while Correct State is on. */
    simple(action, expected) {
        this.deps.send(this.id, action)
            .then(() => {
            this.deps.log.info(`${this.name}: sent ${this.describe(action)}`);
            this.state = { ...this.state, ...expected };
        })
            .catch(e => this.deps.log.error(`${this.name}: ${action.name} failed: ${e.message}`))
            .finally(() => this.onChange());
    }
}
exports.DeviceCore = DeviceCore;
