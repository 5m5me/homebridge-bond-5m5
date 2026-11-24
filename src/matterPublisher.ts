import { DeviceCore } from './deviceCore';
import { LightPart } from './logic';
import { Published, Publisher } from './publisher';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { Logger } from './types';

type Attributes = Record<string, unknown>;
type Handler = (args?: Record<string, unknown>) => void;

export interface MatterAccessoryLike {
  UUID: string;
  displayName: string;
  deviceType?: unknown;
  serialNumber?: string;
  manufacturer?: string;
  model?: string;
  context?: { bondId?: string; deviceId?: string; extra?: string };
  clusters?: Record<string, Attributes>;
  handlers?: Record<string, Record<string, Handler>>;
}

/** The part of Homebridge's Matter interface this plugin uses (Homebridge 2). */
export interface MatterApiLike {
  deviceTypes: Record<string, unknown>;
  registerPlatformAccessories(plugin: string, platform: string, accessories: MatterAccessoryLike[]): Promise<void>;
  unregisterPlatformAccessories(plugin: string, platform: string, accessories: MatterAccessoryLike[]): Promise<void>;
  updateAccessoryState(uuid: string, cluster: string, attributes: Attributes): Promise<void>;
}

/** Matter fan modes. The fan cluster has no on/off command, only this mode and a percentage. */
export function fanModeFor(percent: number): number {
  return percent <= 0 ? 0 : percent <= 33 ? 1 : percent <= 66 ? 2 : 3;
}

/** Matter brightness runs 1 to 254. */
export const levelFromPercent = (percent: number): number => Math.max(1, Math.min(254, Math.round((percent / 100) * 254)));
export const percentFromLevel = (level: number): number => Math.max(1, Math.min(100, Math.round((level / 254) * 100)));

interface Shown {
  /** Which tile: undefined for the device itself, otherwise the id of one of its extra tiles. */
  partId?: string;
  cluster: string;
  attributes: Attributes;
}

/** What each Matter endpoint of a device should show right now. */
export function matterState(core: DeviceCore): Shown[] {
  const f = core.features;
  const out: Shown[] = [];
  const light = (partId: string | undefined, part: LightPart, dimmable: boolean): void => {
    out.push({ partId, cluster: 'onOff', attributes: { onOff: core.lightOn(part) } });
    const level = core.lightLevel(part);
    if (dimmable && level !== undefined) {
      out.push({ partId, cluster: 'levelControl', attributes: { currentLevel: levelFromPercent(level) } });
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
  } else {
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
export function fanPercent(core: DeviceCore): number {
  return Math.round(core.speedPercent() ?? 100);
}

/**
 * Builds the Matter accessories for a device. The first is the device itself (a fan or a light).
 * Each extra (reverse, breeze, timers, lights on a fan, dimmer, correct state) is its own accessory with its own name.
 * They are not child parts of the fan, because Apple Home shows every part under the parent's name
 * and turns the fan's icon into a power strip.
 */
export function buildMatterAccessories(
  matter: MatterApiLike, uuidFor: (extra?: string) => string, bondId: string, core: DeviceCore,
): MatterAccessoryLike[] {
  const f = core.features;
  const types = matter.deviceTypes;
  const state = matterState(core);
  const model = core.device.template || core.device.type || 'Bond device';
  const initial = (partId: string | undefined): Record<string, Attributes> => {
    const clusters: Record<string, Attributes> = {};
    state.filter(s => s.partId === partId).forEach(s => { clusters[s.cluster] = { ...s.attributes }; });
    return clusters;
  };
  const base = (extra: string | undefined, displayName: string): MatterAccessoryLike => ({
    UUID: uuidFor(extra),
    displayName,
    serialNumber: extra ? `${core.id}-${extra}` : core.id,
    manufacturer: 'Bond',
    model,
    context: { bondId, deviceId: core.id, ...(extra ? { extra } : {}) },
    clusters: initial(extra),
  });
  const extras: MatterAccessoryLike[] = [];
  const switchTile = (id: string, displayName: string, isOn: () => boolean, set: (on: boolean) => void): void => {
    // The Matter library can report our own state updates back as commands. Ignore anything that changes nothing.
    const handler = (on: boolean) => (): void => {
      if (isOn() !== on) {
        set(on);
      }
    };
    extras.push({ ...base(id, displayName), deviceType: types.OnOffOutlet, handlers: { onOff: { on: handler(true), off: handler(false) } } });
  };
  const lightEndpoint = (part: LightPart, dimmable: boolean): Pick<MatterAccessoryLike, 'deviceType' | 'handlers'> => {
    const toLevel: Handler = args => {
      const level = Number(args?.level);
      if (level > 0) {
        core.wishLight(part, { on: true, brightness: percentFromLevel(level) });
      }
    };
    return {
      deviceType: dimmable ? types.DimmableLight : types.OnOffLight,
      handlers: {
        onOff: {
          on: () => { if (!core.lightOn(part)) { core.wishLight(part, { on: true }); } },
          off: () => { if (core.lightOn(part)) { core.wishLight(part, { on: false }); } },
        },
        ...(dimmable ? { levelControl: { moveToLevel: toLevel, moveToLevelWithOnOff: toLevel } } : {}),
      },
    };
  };

  const main = base(undefined, core.name);
  if (f.fan) {
    main.deviceType = types.Fan;
    main.clusters!.fanControl = { ...main.clusters!.fanControl, fanModeSequence: 0 };
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
          } else if (f.speed) {
            core.wishSpeedPercent(percent);
          } else {
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
  } else if (f.lights.length) {
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
export class MatterPublisher implements Publisher {
  readonly label = 'Matter';
  private readonly live = new Map<string, MatterAccessoryLike>();
  private readonly byDevice = new Map<string, MatterAccessoryLike[]>();

  constructor(
    private readonly matter: MatterApiLike,
    private readonly log: Logger,
    /** Accessories Homebridge remembered from the last run. */
    readonly cached: Map<string, MatterAccessoryLike>,
    private readonly uuidFor: (seed: string) => string,
  ) {}

  async publish(bondId: string, core: DeviceCore): Promise<Published> {
    const key = `${bondId}:${core.id}`;
    const uuidFor = (extra?: string): string => this.uuidFor(`bond5m5:matter:${key}${extra ? `:${extra}` : ''}`);
    const sent = new Map<string, string>();
    const push = (): void => {
      for (const s of matterState(core)) {
        const id = `${s.partId ?? ''}|${s.cluster}`;
        const value = JSON.stringify(s.attributes);
        if (sent.get(id) === value) {
          continue;
        }
        sent.set(id, value);
        this.matter.updateAccessoryState(uuidFor(s.partId), s.cluster, s.attributes)
          .catch(e => this.log.debug(`${core.name}: Matter state update failed: ${(e as Error).message}`));
      }
    };
    const register = async (): Promise<void> => {
      const accessories = buildMatterAccessories(this.matter, uuidFor, bondId, core);
      // Extras that existed before but are no longer wanted (a setting was turned off, or the device changed).
      const wanted = new Set(accessories.map(a => a.UUID));
      const gone = [...this.cached.values()].filter(a =>
        a.context?.bondId === bondId && a.context.deviceId === core.id && !wanted.has(a.UUID));
      if (gone.length) {
        await this.matter.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, gone);
        gone.forEach(a => { this.cached.delete(a.UUID); this.live.delete(a.UUID); });
      }
      // Handlers cannot be remembered by Homebridge, so every accessory is registered on every start.
      await this.matter.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, accessories);
      accessories.forEach(a => { this.live.set(a.UUID, a); this.cached.set(a.UUID, a); });
      this.byDevice.set(key, accessories);
      // A remembered accessory keeps its old state, so the current state is sent after registering.
      sent.clear();
      push();
    };
    const unregister = async (): Promise<void> => {
      const accessories = this.byDevice.get(key) ?? [];
      if (accessories.length) {
        await this.matter.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, accessories);
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
        core.onChange = () => undefined;
        await unregister();
      },
    };
  }

  private async drop(match: (a: MatterAccessoryLike) => boolean): Promise<number> {
    const gone = [...this.cached.values()].filter(a => !this.live.has(a.UUID) && match(a));
    if (gone.length) {
      await this.matter.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, gone);
      gone.forEach(a => this.cached.delete(a.UUID));
    }
    return gone.length;
  }

  async removeStale(bondId: string, liveDeviceIds: string[]): Promise<void> {
    await this.drop(a => a.context?.bondId === bondId && !(a.context.deviceId && liveDeviceIds.includes(a.context.deviceId)));
  }

  async removeOrphans(bondIds: string[]): Promise<void> {
    await this.drop(a => !a.context?.bondId || !bondIds.includes(a.context.bondId));
  }

  async removeAll(): Promise<number> {
    return this.drop(() => true);
  }
}
