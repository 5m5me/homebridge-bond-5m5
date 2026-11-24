import type { API, PlatformAccessory } from 'homebridge';
import { BondClient, BondHttpError } from './bondClient';
import { PushListener } from './bpup';
import { describeDevice, mapCapabilities } from './capabilities';
import { BondDeviceAccessory } from './deviceAccessory';
import { locateBridge } from './locator';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { BridgeStore } from './store';
import { Logger } from './types';

export interface BridgeConfig {
  name: string;
  host: string;
  token: string;
  hideDeviceIds: string[];
}

export interface BridgeOptions {
  pollSeconds: number;
  correctStateSwitch: boolean;
  dimmerSwitch: boolean;
  bpupPort: number;
}

const DEVICE_REFRESH_MS = 5 * 60 * 1000;
const SEARCH_AFTER_MS = 90 * 1000;
const SEARCH_EVERY_MS = 5 * 60 * 1000;

/** Everything to do with one Bond Bridge: connecting, devices, state, and finding it again if it moves. */
export class BridgeSession {
  readonly client: BondClient;
  bondId?: string;
  private push?: PushListener;
  private readonly devices = new Map<string, BondDeviceAccessory>();
  private readonly hashes = new Map<string, string>();
  private online = false;
  private offlineSince = 0;
  private lastSearchAt = 0;
  private lastDeviceRefreshAt = 0;
  private reported = false;
  private timer?: NodeJS.Timeout;
  private stopped = false;

  constructor(
    private readonly api: API,
    private readonly log: Logger,
    private readonly cfg: BridgeConfig,
    private readonly opts: BridgeOptions,
    private readonly store: BridgeStore,
    private readonly cached: Map<string, PlatformAccessory>,
    private readonly onIdentified: () => void,
  ) {
    const remembered = store.get(cfg.host);
    this.bondId = remembered?.bondId;
    this.client = new BondClient(remembered?.lastHost ?? cfg.host, cfg.token);
  }

  start(): void {
    void this.tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.push?.stop();
    this.devices.forEach(d => d.stop());
  }

  private schedule(): void {
    if (!this.stopped) {
      this.timer = setTimeout(() => void this.tick(), this.opts.pollSeconds * 1000);
    }
  }

  private async tick(): Promise<void> {
    try {
      if (!this.push) {
        await this.identify();
      }
      if (Date.now() - this.lastDeviceRefreshAt >= DEVICE_REFRESH_MS) {
        await this.refreshDevices();
      } else {
        await this.pollStates();
      }
      this.setOnline(true);
    } catch (e) {
      if (e instanceof BondHttpError && e.status === 401) {
        this.log.error(`${this.cfg.name}: the bridge refused the token. Check the token in the plugin settings.`);
      } else {
        this.log.debug(`${this.cfg.name}: ${(e as Error).message}`);
      }
      this.setOnline(false);
      await this.searchIfLost();
    }
    this.schedule();
  }

  private async identify(): Promise<void> {
    let version: Record<string, unknown>;
    try {
      version = await this.client.version();
    } catch (e) {
      // The remembered address may be stale. Try the address typed in the config before giving up.
      if (this.client.host === this.cfg.host) {
        throw e;
      }
      const remembered = this.client.host;
      this.client.host = this.cfg.host;
      try {
        version = await this.client.version();
      } catch {
        this.client.host = remembered;
        throw e;
      }
    }
    const id = typeof version.bondid === 'string' && version.bondid ? version.bondid : this.bondId ?? this.cfg.host;
    if (this.bondId && this.bondId.toLowerCase() !== id.toLowerCase()) {
      this.log.warn(`${this.cfg.name}: a different Bond (${id}) now answers at ${this.client.host}. Expected ${this.bondId}.`);
    }
    this.bondId = id;
    this.store.set(this.cfg.host, { bondId: id, lastHost: this.client.host });
    this.log.info(`${this.cfg.name}: connected to Bond ${id} at ${this.client.host}`
      + ` (firmware ${String(version.fw_ver ?? 'unknown')}, model ${String(version.model ?? version.target ?? 'unknown')})`);
    this.push = new PushListener(this.client.host, this.opts.bpupPort, {
      onState: (deviceId, state) => this.devices.get(deviceId)?.updateState(state),
    });
    this.push.start();
    this.onIdentified();
  }

  private uuid(deviceId: string): string {
    return this.api.hap.uuid.generate(`bond5m5:${this.bondId}:${deviceId}`);
  }

  private async refreshDevices(): Promise<void> {
    const index = await this.client.deviceIndex();
    const wanted = Object.keys(index.devices).filter(id => !this.cfg.hideDeviceIds.includes(id));
    const report: string[] = [];

    for (const id of wanted) {
      const hash = index.devices[id];
      const existing = this.devices.get(id);
      if (existing && this.hashes.get(id) === hash) {
        existing.updateState(await this.client.state(id));
        continue;
      }
      const device = await this.client.device(id, hash);
      const caps = mapCapabilities(device);
      report.push(...describeDevice(device, caps));
      this.hashes.set(id, hash);
      if (caps.kind === 'unsupported') {
        this.remove(id);
        continue;
      }
      if (existing) {
        existing.configure(device);
        this.api.updatePlatformAccessories([existing.accessory]);
        this.log.info(`${this.cfg.name}: "${device.name}" changed in the Bond app, updated.`);
        continue;
      }
      const uuid = this.uuid(id);
      const deps = {
        api: this.api,
        log: this.log,
        send: this.client.action.bind(this.client),
        patch: this.client.patchState.bind(this.client),
        isOnline: () => this.online,
        correctStateSwitch: this.opts.correctStateSwitch,
        dimmerSwitch: this.opts.dimmerSwitch,
      };
      let accessory = this.cached.get(uuid);
      if (accessory) {
        accessory.context = { bondId: this.bondId, deviceId: id };
        this.devices.set(id, new BondDeviceAccessory(accessory, device, deps));
        this.api.updatePlatformAccessories([accessory]);
      } else {
        accessory = new this.api.platformAccessory(device.name, uuid);
        accessory.context = { bondId: this.bondId, deviceId: id };
        this.devices.set(id, new BondDeviceAccessory(accessory, device, deps));
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.cached.set(uuid, accessory);
        if (this.reported) {
          this.log.info(`${this.cfg.name}: new device "${device.name}" added to Apple Home.`);
        }
      }
    }

    // Devices deleted from the Bond app, or now hidden in the config.
    for (const id of [...this.devices.keys()]) {
      if (!wanted.includes(id)) {
        this.remove(id);
      }
    }
    for (const [uuid, accessory] of [...this.cached]) {
      const ctx = accessory.context as { bondId?: string; deviceId?: string };
      if (ctx.bondId === this.bondId && ctx.deviceId && !this.devices.has(ctx.deviceId)) {
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.cached.delete(uuid);
      }
    }

    if (report.length) {
      this.log.info(`${this.cfg.name}: device report${this.reported ? ' (changes)' : ''}:`);
      report.forEach(line => this.log.info(line));
    }
    if (!this.reported && wanted.length === 0) {
      this.log.info(`${this.cfg.name}: the bridge has no devices to show yet.`);
    }
    this.reported = true;
    this.lastDeviceRefreshAt = Date.now();
  }

  private remove(id: string): void {
    const dev = this.devices.get(id);
    if (!dev) {
      return;
    }
    dev.stop();
    this.devices.delete(id);
    this.hashes.delete(id);
    this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [dev.accessory]);
    this.cached.delete(dev.accessory.UUID);
    this.log.info(`${this.cfg.name}: "${dev.accessory.displayName}" removed from Apple Home.`);
  }

  private async pollStates(): Promise<void> {
    for (const [id, dev] of this.devices) {
      try {
        dev.updateState(await this.client.state(id));
      } catch (e) {
        if (e instanceof BondHttpError && e.status === 404) {
          this.lastDeviceRefreshAt = 0; // the device is gone. Rebuild the list on the next round.
          continue;
        }
        throw e;
      }
    }
    if (this.devices.size === 0) {
      await this.client.version();
    }
  }

  private setOnline(online: boolean): void {
    if (online === this.online) {
      return;
    }
    this.online = online;
    if (online) {
      if (this.offlineSince) {
        this.log.info(`${this.cfg.name}: the bridge is answering again.`);
      }
      this.offlineSince = 0;
    } else {
      this.offlineSince = Date.now();
      this.log.warn(`${this.cfg.name}: the bridge is not answering at ${this.client.host}.`);
    }
    this.devices.forEach(d => d.refresh());
  }

  private async searchIfLost(): Promise<void> {
    if (!this.offlineSince) {
      this.offlineSince = Date.now(); // never connected since start
      this.log.warn(`${this.cfg.name}: cannot reach the bridge at ${this.client.host}. Trying again every ${this.opts.pollSeconds} seconds.`);
    }
    const now = Date.now();
    const known = this.bondId && this.bondId !== this.cfg.host;
    if (!known || now - this.offlineSince < SEARCH_AFTER_MS || now - this.lastSearchAt < SEARCH_EVERY_MS) {
      return;
    }
    this.lastSearchAt = now;
    this.log.warn(`${this.cfg.name}: searching the network for Bond ${this.bondId}.`);
    const found = await locateBridge(this.bondId!, [this.cfg.host, `${this.bondId}.local`], this.client.host);
    if (found && found !== this.client.host) {
      this.log.warn(`${this.cfg.name}: address has changed: ${this.client.host} -> ${found}`);
      this.client.host = found;
      this.push?.setHost(found);
      this.store.set(this.cfg.host, { bondId: this.bondId!, lastHost: found });
    }
  }
}
