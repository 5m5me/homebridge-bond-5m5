"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MatterPublisher = exports.percentFromLevel = exports.levelFromPercent = void 0;
exports.fanModeFor = fanModeFor;
exports.matterState = matterState;
exports.fanPercent = fanPercent;
exports.buildMatterAccessory = buildMatterAccessory;
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
/** What each Matter endpoint of a device should show right now. */
function matterState(core) {
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
        out.push({ cluster: 'fanControl', attributes: { fanMode: fanModeFor(percent), percentSetting: percent, percentCurrent: percent } });
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
/** Builds the Matter accessory for a device: a fan (or light) with the extras as on/off parts. */
function buildMatterAccessory(matter, uuid, bondId, core) {
    const f = core.features;
    const types = matter.deviceTypes;
    const parts = [];
    const state = matterState(core);
    const initial = (partId) => {
        const clusters = {};
        state.filter(s => s.partId === partId).forEach(s => { clusters[s.cluster] = { ...s.attributes }; });
        return clusters;
    };
    const switchPart = (id, displayName, isOn, set) => {
        // The Matter library can report our own state updates back as commands. Ignore anything that changes nothing.
        const handler = (on) => () => {
            if (isOn() !== on) {
                set(on);
            }
        };
        parts.push({ id, displayName, deviceType: types.OnOffOutlet, clusters: initial(id), handlers: { onOff: { on: handler(true), off: handler(false) } } });
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
    const accessory = {
        UUID: uuid,
        displayName: core.name,
        serialNumber: core.id,
        manufacturer: 'Bond',
        model: core.device.template || core.device.type || 'Bond device',
        context: { bondId, deviceId: core.id },
        clusters: initial(undefined),
    };
    if (f.fan) {
        accessory.deviceType = types.Fan;
        accessory.clusters.fanControl = { ...accessory.clusters.fanControl, fanModeSequence: 0 };
        accessory.handlers = {
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
            switchPart('reverse', `${core.name} Reverse`, () => core.reversed(), on => core.wishFan({ direction: on ? -1 : 1 }));
        }
        if (f.breeze) {
            switchPart('breeze', `${core.name} Breeze`, () => core.breezeOn(), on => core.setBreeze(on));
        }
        for (const hours of f.timers) {
            switchPart(`timer-${hours}`, `${core.name} Off in ${hours}h`, () => core.timerOn(hours), on => core.setTimer(hours, on));
        }
        for (const l of f.lights) {
            parts.push({ id: l.part, displayName: l.name, clusters: initial(l.part), ...lightEndpoint(l.part, l.dimmable) });
        }
    }
    else if (f.lights.length) {
        const [first, ...rest] = f.lights;
        Object.assign(accessory, lightEndpoint(first.part, first.dimmable));
        for (const l of rest) {
            parts.push({ id: l.part, displayName: l.name, clusters: initial(l.part), ...lightEndpoint(l.part, l.dimmable) });
        }
    }
    if (f.dimmer) {
        switchPart('dimmer', `${core.name} Dimmer`, () => core.dimming, on => core.setDimmer(on));
    }
    if (f.correct) {
        switchPart('correct', `${core.name} Correct State`, () => core.correcting, on => core.setCorrecting(on));
    }
    if (parts.length) {
        accessory.parts = parts;
    }
    return accessory;
}
/** Publishes devices as Matter accessories through Homebridge 2's Matter bridge. */
class MatterPublisher {
    matter;
    log;
    cached;
    uuidFor;
    label = 'Matter';
    live = new Map();
    constructor(matter, log, 
    /** Accessories Homebridge remembered from the last run. */
    cached, uuidFor) {
        this.matter = matter;
        this.log = log;
        this.cached = cached;
        this.uuidFor = uuidFor;
    }
    async publish(bondId, core) {
        const uuid = this.uuidFor(`bond5m5:matter:${bondId}:${core.id}`);
        const sent = new Map();
        const push = () => {
            for (const s of matterState(core)) {
                const key = `${s.partId ?? ''}|${s.cluster}`;
                const value = JSON.stringify(s.attributes);
                if (sent.get(key) === value) {
                    continue;
                }
                sent.set(key, value);
                this.matter.updateAccessoryState(uuid, s.cluster, s.attributes, s.partId)
                    .catch(e => this.log.debug(`${core.name}: Matter state update failed: ${e.message}`));
            }
        };
        const register = async () => {
            const accessory = buildMatterAccessory(this.matter, uuid, bondId, core);
            // Handlers cannot be remembered by Homebridge, so every accessory is registered on every start.
            await this.matter.registerPlatformAccessories(settings_1.PLUGIN_NAME, settings_1.PLATFORM_NAME, [accessory]);
            this.live.set(uuid, accessory);
            this.cached.set(uuid, accessory);
            // A remembered accessory keeps its old state, so the current state is sent after registering.
            sent.clear();
            push();
        };
        const unregister = async () => {
            const accessory = this.live.get(uuid) ?? this.cached.get(uuid);
            if (accessory) {
                await this.matter.unregisterPlatformAccessories(settings_1.PLUGIN_NAME, settings_1.PLATFORM_NAME, [accessory]);
            }
            this.live.delete(uuid);
            this.cached.delete(uuid);
        };
        core.onChange = push;
        await register();
        return {
            reconfigure: async () => {
                await unregister();
                await register();
            },
            remove: async () => {
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
