"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.mapCapabilities = mapCapabilities;
exports.describeDevice = describeDevice;
const DEFAULT_MAX_SPEED = 3;
function powerMode(has, on, off, toggle) {
    if (has(on) && has(off)) {
        return 'direct';
    }
    if (has(toggle)) {
        return 'toggle';
    }
    return has(off) ? 'offOnly' : 'none';
}
function mapCapabilities(dev) {
    const used = new Set();
    const has = (a) => {
        if (dev.actions.includes(a)) {
            used.add(a);
            return true;
        }
        return false;
    };
    const featureOff = (name) => dev.properties[name] === false;
    const caps = { kind: 'unsupported', unused: [] };
    if (dev.type === 'CF') {
        caps.kind = 'fan';
        const rawMax = Number(dev.properties.max_speed);
        const maxKnown = Number.isInteger(rawMax) && rawMax > 0;
        const speed = has('SetSpeed');
        caps.fan = {
            power: powerMode(has, 'TurnOn', 'TurnOff', 'TogglePower'),
            speed,
            maxSpeed: maxKnown ? rawMax : DEFAULT_MAX_SPEED,
            maxSpeedAssumed: speed && !maxKnown,
            direction: has('SetDirection') ? 'set' : has('ToggleDirection') ? 'toggle' : 'none',
            breeze: has('BreezeOn') && has('BreezeOff'),
            timer: has('SetTimer'),
        };
    }
    else if (dev.type === 'LT') {
        caps.kind = 'light';
    }
    if (caps.kind !== 'unsupported' && !featureOff('feature_light')) {
        const upDown = !featureOff('feature_up_down_light')
            && has('TurnUpLightOn') && has('TurnUpLightOff') && has('TurnDownLightOn') && has('TurnDownLightOff');
        const power = powerMode(has, 'TurnLightOn', 'TurnLightOff', 'ToggleLight');
        const brightnessAllowed = !featureOff('feature_brightness');
        if (upDown) {
            caps.light = {
                kind: 'updown',
                power,
                brightness: false,
                upDownBrightness: brightnessAllowed && has('SetUpLightBrightness') && has('SetDownLightBrightness'),
                dimmer: false,
            };
        }
        else if (power !== 'none') {
            const brightness = brightnessAllowed && has('SetBrightness');
            caps.light = {
                kind: 'single',
                power,
                brightness,
                upDownBrightness: false,
                dimmer: !brightness && brightnessAllowed && has('StartDimmer') && has('Stop'),
            };
        }
    }
    if (caps.kind === 'light' && !caps.light) {
        caps.kind = 'unsupported';
    }
    caps.unused = caps.kind === 'unsupported' ? [...dev.actions] : dev.actions.filter(a => !used.has(a));
    return caps;
}
/** Plain-language lines for the startup report in the Homebridge log. */
function describeDevice(dev, caps) {
    const lines = [`Device "${dev.name}" (id ${dev.id}, type ${dev.type}${dev.template ? `, template ${dev.template}` : ''})`];
    if (caps.kind === 'unsupported') {
        lines.push('  Not shown in Apple Home: this device type is not supported by this plugin version.');
    }
    if (caps.fan) {
        const f = caps.fan;
        const power = { direct: 'separate on and off', toggle: 'toggle only', offOnly: 'off button only (a speed turns it on)', none: 'no power button (a speed turns it on)' };
        lines.push(`  Fan power: ${power[f.power]}`);
        lines.push(f.speed
            ? `  Fan speeds: ${f.maxSpeed}${f.maxSpeedAssumed ? ' (assumed, the bridge did not report max_speed)' : ''}`
            : '  Fan speeds: not settable (on and off only)');
        lines.push(`  Direction: ${f.direction === 'none' ? 'not available' : f.direction === 'set' ? 'available' : 'available (toggle only)'}`);
        lines.push(`  Breeze mode: ${f.breeze ? 'available' : 'not offered by the bridge for this device'}`);
        lines.push(`  Sleep timer: ${f.timer ? 'available' : 'not offered by the bridge for this device'}`);
    }
    if (caps.light) {
        const l = caps.light;
        lines.push(`  Light: ${l.kind === 'updown' ? 'separate up and down lights' : 'yes'}${l.power === 'toggle' ? ' (toggle only)' : ''}`);
        const dim = l.brightness || l.upDownBrightness ? 'brightness slider'
            : l.dimmer ? 'hold-to-dim only (shown as a Dimmer switch)' : 'none';
        lines.push(`  Dimming: ${dim}`);
    }
    else if (caps.kind === 'fan') {
        lines.push('  Light: none');
    }
    lines.push(`  All actions from the bridge: ${dev.actions.join(', ') || 'none'}`);
    if (caps.unused.length && caps.kind !== 'unsupported') {
        lines.push(`  Not used by this plugin version: ${caps.unused.join(', ')}`);
    }
    return lines;
}
