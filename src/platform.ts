import path from 'node:path';
import type { API, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig } from 'homebridge';
import { BridgeConfig, BridgeSession } from './bridge';
import { HapPublisher } from './hapPublisher';
import { MatterAccessoryLike, MatterApiLike, MatterPublisher } from './matterPublisher';
import { Publisher } from './publisher';
import { BPUP_PORT } from './settings';
import { BridgeStore } from './store';
import { Logger } from './types';

export function readBridges(config: Record<string, unknown>, warn: (m: string) => void): BridgeConfig[] {
  const out: BridgeConfig[] = [];
  const list = Array.isArray(config.bridges) ? config.bridges : [];
  list.forEach((raw: Record<string, unknown> | null, i: number) => {
    const host = typeof raw?.host === 'string' ? raw.host.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '') : '';
    const token = typeof raw?.token === 'string' ? raw.token.trim() : '';
    if (!host || !token) {
      warn(`Bridge ${i + 1} in the settings needs both an address and a token. Skipped.`);
      return;
    }
    if (out.some(b => b.host === host)) {
      warn(`Bridge ${i + 1} repeats the address ${host}. Skipped.`);
      return;
    }
    const hide = Array.isArray(raw?.hideDeviceIds) ? raw.hideDeviceIds.map(v => String(v).trim()).filter(Boolean) : [];
    const name = typeof raw?.name === 'string' && raw.name.trim() ? raw.name.trim() : `Bond ${i + 1}`;
    out.push({ name, host, token, hideDeviceIds: hide });
  });
  return out;
}

export function readPollSeconds(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 5 ? Math.min(Math.round(n), 600) : 30;
}

export type Connection = 'homekit' | 'matter';

/** Decides which connection carries the devices. They are never published over both, or every tile would appear twice. */
export function chooseConnection(setting: unknown, matterOn: boolean, hapOn: boolean, warn: (m: string) => void): Connection {
  const wanted = setting === 'homekit' || setting === 'matter' ? setting : 'auto';
  if (wanted === 'matter' && !matterOn) {
    warn('The settings ask for Matter, but Matter is not switched on for this bridge. Using HomeKit instead.');
    return 'homekit';
  }
  if (wanted === 'homekit' && !hapOn && matterOn) {
    warn('The settings ask for HomeKit, but HomeKit (HAP) is switched off for this bridge. Using Matter instead.');
    return 'matter';
  }
  if (wanted === 'auto') {
    return matterOn ? 'matter' : 'homekit';
  }
  return wanted;
}

interface MaybeMatterApi {
  matter?: MatterApiLike;
  isMatterEnabled?: () => boolean;
  isHapEnabled?: () => boolean;
}

export class Bond5m5Platform implements DynamicPlatformPlugin {
  private readonly hap: HapPublisher;
  private readonly matterCache = new Map<string, MatterAccessoryLike>();
  private publisher!: Publisher;
  private readonly sessions: BridgeSession[] = [];
  private readonly logger: Logger;

  constructor(private readonly log: Logging, private readonly config: PlatformConfig, private readonly api: API) {
    const debug = config.debug === true;
    this.logger = {
      info: m => log.info(m),
      warn: m => log.warn(m),
      error: m => log.error(m),
      debug: m => (debug ? log.info(`[debug] ${m}`) : log.debug(m)),
    };
    this.hap = new HapPublisher(api);
    api.on('didFinishLaunching', () => void this.launch());
    api.on('shutdown', () => this.sessions.forEach(s => s.stop()));
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.hap.cached.set(accessory.UUID, accessory);
  }

  /** Homebridge 2 hands back the Matter accessories it remembered. */
  configureMatterAccessory(accessory: MatterAccessoryLike): void {
    this.matterCache.set(accessory.UUID, accessory);
  }

  private async launch(): Promise<void> {
    const bridges = readBridges(this.config, m => this.log.warn(m));
    if (!bridges.length) {
      this.log.warn('No Bond Bridge is set up. Add its address and token in the plugin settings.');
    }
    const maybe = this.api as unknown as MaybeMatterApi;
    const matterOn = typeof maybe.isMatterEnabled === 'function' && maybe.isMatterEnabled() && !!maybe.matter;
    const hapOn = typeof maybe.isHapEnabled === 'function' ? maybe.isHapEnabled() : true;
    const connection = chooseConnection(this.config.connection, matterOn, hapOn, m => this.log.warn(m));
    const matter = matterOn
      ? new MatterPublisher(maybe.matter!, this.logger, this.matterCache, seed => this.api.hap.uuid.generate(seed))
      : undefined;
    this.publisher = connection === 'matter' ? matter! : this.hap;
    const other: Publisher | undefined = connection === 'matter' ? this.hap : matter;
    this.log.info(`Devices are published over ${this.publisher.label}.`
      + (connection === 'homekit' && !hapOn ? ' HomeKit (HAP) is switched off for this bridge, so nothing will show until it is switched on.' : ''));
    try {
      const removed = other ? await other.removeAll() : 0;
      if (removed) {
        this.log.info(`Removed ${removed} device(s) from ${other!.label} so nothing shows twice.`);
      }
    } catch (e) {
      this.log.warn(`Could not clear the ${other!.label} side: ${(e as Error).message}`);
    }
    const store = new BridgeStore(path.join(this.api.user.storagePath(), 'bond-5m5-bridges.json'));
    const options = {
      pollSeconds: readPollSeconds(this.config.pollSeconds),
      correctStateSwitch: this.config.correctStateSwitch === true,
      dimmerSwitch: this.config.dimmerSwitch !== false,
      breezeSwitch: this.config.breezeSwitch !== false,
      timerHours: this.config.timerSwitches === false ? [] : [1, 2, 4, 8],
      bpupPort: Number(this.config.bpupPort) > 0 ? Number(this.config.bpupPort) : BPUP_PORT,
    };
    for (const cfg of bridges) {
      const session = new BridgeSession(this.logger, cfg, options, store, this.publisher, () => this.removeOrphans());
      this.sessions.push(session);
      session.start();
    }
    this.removeOrphans();
  }

  /** Removes tiles that belong to a bridge no longer in the settings. Waits until every bridge is identified. */
  private removeOrphans(): void {
    if (this.sessions.some(s => !s.bondId)) {
      return;
    }
    const ids = this.sessions.map(s => s.bondId!);
    this.publisher.removeOrphans(ids).catch(e => this.log.warn(`Could not remove old devices: ${(e as Error).message}`));
  }
}
