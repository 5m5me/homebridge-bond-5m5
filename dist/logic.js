"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.speedToPercent = speedToPercent;
exports.percentToSpeed = percentToSpeed;
exports.planFan = planFan;
exports.fanPatch = fanPatch;
exports.lightIsOn = lightIsOn;
exports.lightLevel = lightLevel;
exports.planLight = planLight;
exports.lightPatch = lightPatch;
function speedToPercent(speed, max) {
    if (!(speed > 0)) {
        return 0;
    }
    return Math.min(100, Math.round((Math.min(speed, max) / max) * 10000) / 100);
}
function percentToSpeed(percent, max) {
    if (!(percent > 0)) {
        return 0;
    }
    return Math.max(1, Math.min(max, Math.round((percent / 100) * max)));
}
const isOn = (v) => v === 1 || v === true;
/** Commands to send so the fan matches the wish, given what the bridge believes now. */
function planFan(wish, state, caps) {
    const out = [];
    const on = isOn(state.power);
    const wantOff = wish.active === false || wish.speed === 0;
    if (wantOff) {
        if (caps.power === 'direct') {
            out.push({ name: 'TurnOff' });
        }
        else if (caps.power === 'toggle' && on) {
            out.push({ name: 'TogglePower' });
        }
        return out;
    }
    const wantSpeed = caps.speed && wish.speed !== undefined && wish.speed > 0;
    if (wantSpeed) {
        if (caps.power === 'toggle' && !on) {
            out.push({ name: 'TogglePower' });
        }
        if ((!on && caps.power !== 'toggle') || Number(state.speed) !== wish.speed) {
            out.push({ name: 'SetSpeed', argument: wish.speed });
        }
    }
    else if (wish.active === true && !on) {
        if (caps.power === 'direct') {
            out.push({ name: 'TurnOn' });
        }
        else if (caps.power === 'toggle') {
            out.push({ name: 'TogglePower' });
        }
    }
    if (wish.direction !== undefined && Number(state.direction) !== wish.direction) {
        if (caps.direction === 'set') {
            out.push({ name: 'SetDirection', argument: wish.direction });
        }
        else if (caps.direction === 'toggle') {
            out.push({ name: 'ToggleDirection' });
        }
    }
    return out;
}
/** State belief to write (no radio signal) for the same wish. Used by "Correct state". */
function fanPatch(wish, caps) {
    const patch = {};
    if (wish.active === false || wish.speed === 0) {
        patch.power = 0;
    }
    else {
        if (wish.active === true || (wish.speed !== undefined && wish.speed > 0)) {
            patch.power = 1;
        }
        if (caps.speed && wish.speed !== undefined && wish.speed > 0) {
            patch.speed = wish.speed;
        }
    }
    if (wish.direction !== undefined && caps.direction !== 'none') {
        patch.direction = wish.direction;
    }
    return patch;
}
const PART = {
    light: { on: 'TurnLightOn', off: 'TurnLightOff', set: 'SetBrightness', flag: 'light', level: 'brightness' },
    up: { on: 'TurnUpLightOn', off: 'TurnUpLightOff', set: 'SetUpLightBrightness', flag: 'up_light', level: 'up_light_brightness' },
    down: { on: 'TurnDownLightOn', off: 'TurnDownLightOff', set: 'SetDownLightBrightness', flag: 'down_light', level: 'down_light_brightness' },
};
function lightIsOn(part, state) {
    if (part === 'light') {
        return isOn(state.light);
    }
    return isOn(state.light) && isOn(state[PART[part].flag]);
}
function lightLevel(part, state) {
    const v = Number(state[PART[part].level]);
    return v >= 1 && v <= 100 ? Math.round(v) : undefined;
}
function planLight(part, wish, state, caps) {
    const out = [];
    const p = PART[part];
    const on = lightIsOn(part, state);
    const canSet = part === 'light' ? caps.brightness : caps.upDownBrightness;
    if (wish.on === false || wish.brightness === 0) {
        if (part !== 'light' || caps.power === 'direct') {
            out.push({ name: p.off });
        }
        else if (caps.power === 'toggle' && on) {
            out.push({ name: 'ToggleLight' });
        }
        return out;
    }
    const wantLevel = canSet && wish.brightness !== undefined && wish.brightness > 0;
    if ((wish.on === true || wantLevel) && !on) {
        if (part !== 'light' || caps.power === 'direct') {
            out.push({ name: p.on });
        }
        else if (caps.power === 'toggle') {
            out.push({ name: 'ToggleLight' });
        }
    }
    if (wantLevel && lightLevel(part, state) !== wish.brightness) {
        out.push({ name: p.set, argument: wish.brightness });
    }
    return out;
}
function lightPatch(part, wish, caps) {
    const p = PART[part];
    const patch = {};
    const canSet = part === 'light' ? caps.brightness : caps.upDownBrightness;
    if (wish.on === false || wish.brightness === 0) {
        patch[p.flag] = 0;
        return patch;
    }
    if (wish.on === true || (wish.brightness !== undefined && wish.brightness > 0)) {
        patch[p.flag] = 1;
        if (part !== 'light') {
            patch.light = 1;
        }
    }
    if (canSet && wish.brightness !== undefined && wish.brightness > 0) {
        patch[p.level] = wish.brightness;
    }
    return patch;
}
