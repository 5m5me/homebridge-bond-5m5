import path from 'node:path';
import type { API, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig } from 'homebridge';
import { BridgeConfig, BridgeSession } from './bridge';
import { BPUP_PORT, PLATFORM_NAME, PLUGIN_NAME } from './settings';
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

export class Bond5m5Platform implements DynamicPlatformPlugin {
  private readonly cached = new Map<string, PlatformAccessory>();
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
    api.on('didFinishLaunching', () => this.launch());
    api.on('shutdown', () => this.sessions.forEach(s => s.stop()));
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.cached.set(accessory.UUID, accessory);
  }

  private launch(): void {
    const bridges = readBridges(this.config, m => this.log.warn(m));
    if (!bridges.length) {
      this.log.warn('No Bond Bridge is set up. Add its address and token in the plugin settings.');
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
      const session = new BridgeSession(this.api, this.logger, cfg, options, store, this.cached,
        () => this.removeOrphans());
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
    const ids = new Set(this.sessions.map(s => s.bondId));
    for (const [uuid, accessory] of [...this.cached]) {
      if (!ids.has((accessory.context as { bondId?: string }).bondId)) {
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.cached.delete(uuid);
        this.log.info(`Removed "${accessory.displayName}": its bridge is no longer in the settings.`);
      }
    }
  }
}
