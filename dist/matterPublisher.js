"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MatterPublisher = exports.percentFromLevel = exports.levelFromPercent = void 0;
exports.fanModeFor = fanModeFor;
exports.multiSpeedFan = multiSpeedFan;
exports.fanSpeedNumber = fanSpeedNumber;
exports.matterState = matterState;
exports.fanPercent = fanPercent;
exports.buildMatterAccessories = buildMatterAccessories;
const settings_1 = require("./settings");
/** Matter fan modes. The fan cluster has no on/off command, only this mode and a percentage. */
function fanModeFor(percent) {
    return percent <= 0 ? 0 : percent <= 33 ? 1 : percent <= 66 ? 2 : 3;
}
/** Matter brightness runs 1 to 254. */
const levelFromPercent = (percent) => Math.max(1, Math.min(254, Math.round((percent / 100) * 254)));
exports.levelFromPercent = levelFromPercent;
const percentFromLevel = (level) => Math.max(1, Math.min(100, Math.round((level / 254) * 100)));
exports.percentFromLevel = percentFromLevel;
/**
 * A fan device type that declares a fixed number of speeds (Matter's MultiSpeed feature).
 * Returns nothing if this Homebridge cannot compose it, and the plain fan is used instead.
 */
function multiSpeedFan(fan) {
    try {
        const type = fan;
        const control = type?.behaviors?.fanControl;
        if (typeof type?.with === 'function' && typeof control?.with === 'function') {
            return type.with(control.with('MultiSpeed'));
        }
    }
    catch {
        // Fall through to the plain fan.
    }
    return undefined;
}
/** The speed number Matter shows: 0 when off. */
function fanSpeedNumber(core) {
    return core.fanOn() ? Math.max(1, Math.min(core.features.maxSpeed, core.speed() || core.features.maxSpeed)) : 0;
}
/** What each Matter endpoint of a device should show right now. */
function matterState(core, multiSpeed = false) {
    const f = core.features;
    const out = [];
    const light = (partId, part, dimmable) => {
        out.push({ partId, cluster: 'onOff', attributes: { onOff: core.lightOn(part) } });
        const level = core.lightLevel(part);
        if (dimmable && level !== undefined) {
            out.push({ partId, cluster: 'levelControl', attributes: { currentLevel: (0, exports.levelFromPercent)(level) } });
        }
    };
    if (f.fan) {
        const percent = fanPercent(core);
        const speed = multiSpeed ? { speedSetting: fanSpeedNumber(core), speedCurrent: fanSpeedNumber(core) } : {};
        out.push({ cluster: 'fanControl', attributes: { fanMode: fanModeFor(percent), percentSetting: percent, percentCurrent: percent, ...speed } });
        if (f.direction) {
            out.push({ partId: 'reverse', cluster: 'onOff', attributes: { onOff: core.reversed() } });
        }
        if (f.breeze) {
            out.push({ partId: 'breeze', cluster: 'onOff', attributes: { onOff: core.breezeOn() } });
        }
        for (const hours of f.timers) {
            out.push({ partId: `timer-${hours}`, cluster: 'onOff', attributes: { onOff: core.timerOn(hours) } });
        }
        f.lights.forEach(l => light(l.part, l.part, l.dimmable));
    }
    else {
        f.lights.forEach((l, i) => light(i === 0 ? undefined : l.part, l.part, l.dimmable));
    }
    if (f.dimmer) {
        out.push({ partId: 'dimmer', cluster: 'onOff', attributes: { onOff: core.dimming } });
    }
    if (f.correct) {
        out.push({ partId: 'correct', cluster: 'onOff', attributes: { onOff: core.correcting } });
    }
    return out;
}
/** Whole-number percentage Matter shows for the fan. On at an unknown speed shows as 100. */
function fanPercent(core) {
    return Math.round(core.speedPercent() ?? 100);
}
/**
 * Builds the Matter accessories for a device. The first is the device itself (a fan or a light).
 * Each extra (reverse, breeze, timers, lights on a fan, dimmer, correct state) is its own accessory with its own name.
 * They are not child parts of the fan, because Apple Home shows every part under the parent's name
 * and turns the fan's icon into a power strip.
 */
function buildMatterAccessories(matter, uuidFor, bondId, core, multiSpeedType) {
    const f = core.features;
    const types = matter.deviceTypes;
    const multi = multiSpeedType !== undefined;
    const state = matterState(core, multi);
    const model = core.device.template || core.device.type || 'Bond device';
    const initial = (partId) => {
        const clusters = {};
        state.filter(s => s.partId === partId).forEach(s => { clusters[s.cluster] = { ...s.attributes }; });
        return clusters;
    };
    const base = (extra, displayName) => ({
        UUID: uuidFor(extra),
        displayName,
        serialNumber: extra ? `${core.id}-${extra}` : core.id,
        manufacturer: 'Bond',
        model,
        context: { bondId, deviceId: core.id, ...(extra ? { extra } : {}) },
        clusters: initial(extra),
    });
    const extras = [];
    const switchTile = (id, displayName, isOn, set) => {
        // The Matter library can report our own state updates back as commands. Ignore anything that changes nothing.
        const handler = (on) => () => {
            if (isOn() !== on) {
                set(on);
            }
        };
        extras.push({ ...base(id, displayName), deviceType: types.OnOffOutlet, handlers: { onOff: { on: handler(true), off: handler(false) } } });
    };
    const lightEndpoint = (part, dimmable) => {
        const toLevel = args => {
            const level = Number(args?.level);
            if (level > 0) {
                core.wishLight(part, { on: true, brightness: (0, exports.percentFromLevel)(level) });
            }
        };
        return {
            deviceType: dimmable ? types.DimmableLight : types.OnOffLight,
            handlers: {
                onOff: {
                    on: () => { if (!core.lightOn(part)) {
                        core.wishLight(part, { on: true });
                    } },
                    off: () => { if (core.lightOn(part)) {
                        core.wishLight(part, { on: false });
                    } },
                },
                ...(dimmable ? { levelControl: { moveToLevel: toLevel, moveToLevelWithOnOff: toLevel } } : {}),
            },
        };
    };
    const main = base(undefined, core.name);
    if (f.fan) {
        main.deviceType = multi ? multiSpeedType : types.Fan;
        main.clusters.fanControl = { ...main.clusters.fanControl, fanModeSequence: 0, ...(multi ? { speedMax: f.maxSpeed } : {}) };
        main.handlers = {
            fanControl: {
                // Matter has no "turn fan on" command. Apple Home writes the mode, the percentage, or both.
                // A change that matches what we already believe is our own update coming back, so it is ignored.
                fanModeChange: args => {
                    const wantOn = Number(args?.fanMode) !== 0;
                    if (wantOn !== core.fanOn()) {
                        core.wishFan({ active: wantOn });
                    }
                },
                percentSettingChange: args => {
                    if (args?.percentSetting === null || args?.percentSetting === undefined) {
                        return;
                    }
                    const percent = Math.round(Number(args.percentSetting));
                    if (percent === fanPercent(core)) {
                        return;
                    }
                    if (percent <= 0) {
                        core.wishFan({ active: false });
                    }
                    else if (f.speed) {
                        core.wishSpeedPercent(percent);
                    }
                    else {
                        core.wishFan({ active: true });
                    }
                },
            },
        };
        if (f.direction) {
            switchTile('reverse', `${core.name} Reverse`, () => core.reversed(), on => core.wishFan({ direction: on ? -1 : 1 }));
        }
        if (f.breeze) {
            switchTile('breeze', `${core.name} Breeze`, () => core.breezeOn(), on => core.setBreeze(on));
        }
        for (const hours of f.timers) {
            switchTile(`timer-${hours}`, `${core.name} Off in ${hours}h`, () => core.timerOn(hours), on => core.setTimer(hours, on));
        }
        for (const l of f.lights) {
            extras.push({ ...base(l.part, l.name), ...lightEndpoint(l.part, l.dimmable) });
        }
    }
    else if (f.lights.length) {
        const [first, ...rest] = f.lights;
        Object.assign(main, lightEndpoint(first.part, first.dimmable));
        for (const l of rest) {
            extras.push({ ...base(l.part, l.name), ...lightEndpoint(l.part, l.dimmable) });
        }
    }
    if (f.dimmer) {
        switchTile('dimmer', `${core.name} Dimmer`, () => core.dimming, on => core.setDimmer(on));
    }
    if (f.correct) {
        switchTile('correct', `${core.name} Correct State`, () => core.correcting, on => core.setCorrecting(on));
    }
    return [main, ...extras];
}
/** Publishes devices as Matter accessories through Homebridge 2's Matter bridge. */
class MatterPublisher {
    matter;
    log;
    cached;
    uuidFor;
    speedSteps;
    label = 'Matter';
    live = new Map();
    byDevice = new Map();
    constructor(matter, log, 
    /** Accessories Homebridge remembered from the last run. */
    cached, uuidFor, 
    /** Experimental: declare each fan's real number of speeds to Matter. */
    speedSteps = false) {
        this.matter = matter;
        this.log = log;
        this.cached = cached;
        this.uuidFor = uuidFor;
        this.speedSteps = speedSteps;
    }
    async publish(bondId, core) {
        const key = `${bondId}:${core.id}`;
        const uuidFor = (extra) => this.uuidFor(`bond5m5:matter:${key}${extra ? `:${extra}` : ''}`);
        const sent = new Map();
        const multiType = this.speedSteps && core.features.speed ? multiSpeedFan(this.matter.deviceTypes.Fan) : undefined;
        const multi = multiType !== undefined;
        let seenSpeed = fanSpeedNumber(core);
        let watch;
        const push = () => {
            if (multi) {
                seenSpeed = fanSpeedNumber(core);
            }
            for (const s of matterState(core, multi)) {
                const id = `${s.partId ?? ''}|${s.cluster}`;
                const value = JSON.stringify(s.attributes);
                if (sent.get(id) === value) {
                    continue;
                }
                sent.set(id, value);
                this.matter.updateAccessoryState(uuidFor(s.partId), s.cluster, s.attributes)
                    .catch(e => this.log.debug(`${core.name}: Matter state update failed: ${e.message}`));
            }
        };
        const register = async () => {
            const accessories = buildMatterAccessories(this.matter, uuidFor, bondId, core, multiType);
            // Extras that existed before but are no longer wanted (a setting was turned off, or the device changed).
            const wanted = new Set(accessories.map(a => a.UUID));
            const gone = [...this.cached.values()].filter(a => a.context?.bondId === bondId && a.context.deviceId === core.id && !wanted.has(a.UUID));
            if (gone.length) {
                await this.matter.unregisterPlatformAccessories(settings_1.PLUGIN_NAME, settings_1.PLATFORM_NAME, gone);
                gone.forEach(a => { this.cached.delete(a.UUID); this.live.delete(a.UUID); });
            }
            // Handlers cannot be remembered by Homebridge, so every accessory is registered on every start.
            await this.matter.registerPlatformAccessories(settings_1.PLUGIN_NAME, settings_1.PLATFORM_NAME, accessories);
            accessories.forEach(a => { this.live.set(a.UUID, a); this.cached.set(a.UUID, a); });
            this.byDevice.set(key, accessories);
            // A remembered accessory keeps its old state, so the current state is sent after registering.
            sent.clear();
            push();
            // Homebridge tells the plugin about mode and percentage changes, but not about a change to the speed number.
            // If Apple Home sets the speed number directly, this is the only way to notice.
            if (multi && this.matter.getAccessoryState && !watch) {
                watch = setInterval(() => {
                    this.matter.getAccessoryState(uuidFor(), 'fanControl').then(state => {
                        const value = Number(state?.speedSetting);
                        if (!Number.isInteger(value) || value === seenSpeed) {
                            return;
                        }
                        seenSpeed = value;
                        if (value !== fanSpeedNumber(core)) {
                            core.wishFan(value <= 0 ? { active: false } : { speed: Math.min(value, core.features.maxSpeed) });
                        }
                    }).catch(() => undefined);
                }, 1000);
                watch.unref();
            }
        };
        const unregister = async () => {
            const accessories = this.byDevice.get(key) ?? [];
            if (accessories.length) {
                await this.matter.unregisterPlatformAccessories(settings_1.PLUGIN_NAME, settings_1.PLATFORM_NAME, accessories);
            }
            accessories.forEach(a => { this.live.delete(a.UUID); this.cached.delete(a.UUID); });
            this.byDevice.delete(key);
        };
        core.onChange = push;
        await register();
        return {
            reconfigure: async () => {
                await unregister();
                await register();
            },
            remove: async () => {
                if (watch) {
                    clearInterval(watch);
                }
                core.onChange = () => undefined;
                await unregister();
            },
        };
    }
    async drop(match) {
        const gone = [...this.cached.values()].filter(a => !this.live.has(a.UUID) && match(a));
        if (gone.length) {
            await this.matter.unregisterPlatformAccessories(settings_1.PLUGIN_NAME, settings_1.PLATFORM_NAME, gone);
            gone.forEach(a => this.cached.delete(a.UUID));
        }
        return gone.length;
    }
    async removeStale(bondId, liveDeviceIds) {
        await this.drop(a => a.context?.bondId === bondId && !(a.context.deviceId && liveDeviceIds.includes(a.context.deviceId)));
    }
    async removeOrphans(bondIds) {
        await this.drop(a => !a.context?.bondId || !bondIds.includes(a.context.bondId));
    }
    async removeAll() {
        return this.drop(() => true);
    }
}
exports.MatterPublisher = MatterPublisher;
