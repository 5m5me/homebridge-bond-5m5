import { BondClient, BondHttpError } from './bondClient';
import { PushListener } from './bpup';
import { describeDevice, mapCapabilities } from './capabilities';
import { CoreOptions, DeviceCore } from './deviceCore';
import { locateBridge } from './locator';
import { Published, Publisher } from './publisher';
import { BridgeStore } from './store';
import { Logger } from './types';

export interface BridgeConfig {
  name: string;
  host: string;
  token: string;
  hideDeviceIds: string[];
}

export interface BridgeOptions extends CoreOptions {
  pollSeconds: number;
  bpupPort: number;
}

interface Entry {
  core: DeviceCore;
  published: Published;
}

const DEVICE_REFRESH_MS = 5 * 60 * 1000;
const SEARCH_AFTER_MS = 90 * 1000;
const SEARCH_EVERY_MS = 5 * 60 * 1000;

/** Everything to do with one Bond Bridge: connecting, devices, state, and finding it again if it moves. */
export class BridgeSession {
  readonly client: BondClient;
  bondId?: string;
  private push?: PushListener;
  private readonly devices = new Map<string, Entry>();
  private readonly hashes = new Map<string, string>();
  private online = false;
  private offlineSince = 0;
  private lastSearchAt = 0;
  private lastDeviceRefreshAt = 0;
  private reported = false;
  private timer?: NodeJS.Timeout;
  private stopped = false;

  constructor(
    private readonly log: Logger,
    private readonly cfg: BridgeConfig,
    private readonly opts: BridgeOptions,
    private readonly store: BridgeStore,
    private readonly publisher: Publisher,
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
    this.devices.forEach(d => d.core.stop());
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
      onState: (deviceId, state) => this.devices.get(deviceId)?.core.updateState(state),
    });
    this.push.start();
    this.onIdentified();
  }

  private async refreshDevices(): Promise<void> {
    const index = await this.client.deviceIndex();
    const wanted = Object.keys(index.devices).filter(id => !this.cfg.hideDeviceIds.includes(id));
    const report: string[] = [];
    const bondId = this.bondId!;

    for (const id of wanted) {
      const hash = index.devices[id];
      const existing = this.devices.get(id);
      if (existing && this.hashes.get(id) === hash) {
        existing.core.updateState(await this.client.state(id));
        continue;
      }
      const device = await this.client.device(id, hash);
      const caps = mapCapabilities(device);
      report.push(...describeDevice(device, caps));
      this.hashes.set(id, hash);
      if (caps.kind === 'unsupported') {
        await this.remove(id);
        continue;
      }
      if (existing) {
        existing.core.setDevice(device);
        await existing.published.reconfigure();
        this.log.info(`${this.cfg.name}: "${device.name}" changed in the Bond app, updated.`);
        continue;
      }
      const core = new DeviceCore(device, {
        log: this.log,
        send: this.client.action.bind(this.client),
        patch: this.client.patchState.bind(this.client),
        isOnline: () => this.online,
        options: this.opts,
      });
      let published: Published;
      try {
        published = await this.publisher.publish(bondId, core);
      } catch (e) {
        this.log.error(`${this.cfg.name}: could not publish "${device.name}" over ${this.publisher.label}: ${(e as Error).message}`);
        this.hashes.delete(id); // try again on the next device refresh
        continue;
      }
      this.devices.set(id, { core, published });
      if (this.reported) {
        this.log.info(`${this.cfg.name}: new device "${device.name}" published over ${this.publisher.label}.`);
      }
    }

    // Devices deleted from the Bond app, or now hidden in the config.
    for (const id of [...this.devices.keys()]) {
      if (!wanted.includes(id)) {
        await this.remove(id);
      }
    }
    await this.publisher.removeStale(bondId, [...this.devices.keys()]);

    if (report.length) {
      this.log.info(`${this.cfg.name}: device report${this.reported ? ' (changes)' : ''}:`);
      report.forEach(line => this.log.info(line));
    }
    if (!this.reported) {
      this.log.info(wanted.length
        ? `${this.cfg.name}: ${this.devices.size} device(s) published over ${this.publisher.label}.`
        : `${this.cfg.name}: the bridge has no devices to show yet.`);
    }
    this.reported = true;
    this.lastDeviceRefreshAt = Date.now();
  }

  private async remove(id: string): Promise<void> {
    const entry = this.devices.get(id);
    if (!entry) {
      return;
    }
    entry.core.stop();
    this.devices.delete(id);
    this.hashes.delete(id);
    await entry.published.remove();
    this.log.info(`${this.cfg.name}: "${entry.core.name}" removed.`);
  }

  private async pollStates(): Promise<void> {
    for (const [id, dev] of this.devices) {
      try {
        dev.core.updateState(await this.client.state(id));
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
    this.devices.forEach(d => d.core.onChange());
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
