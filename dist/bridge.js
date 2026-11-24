"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BridgeSession = void 0;
const bondClient_1 = require("./bondClient");
const bpup_1 = require("./bpup");
const capabilities_1 = require("./capabilities");
const deviceAccessory_1 = require("./deviceAccessory");
const locator_1 = require("./locator");
const settings_1 = require("./settings");
const DEVICE_REFRESH_MS = 5 * 60 * 1000;
const SEARCH_AFTER_MS = 90 * 1000;
const SEARCH_EVERY_MS = 5 * 60 * 1000;
/** Everything to do with one Bond Bridge: connecting, devices, state, and finding it again if it moves. */
class BridgeSession {
    api;
    log;
    cfg;
    opts;
    store;
    cached;
    onIdentified;
    client;
    bondId;
    push;
    devices = new Map();
    hashes = new Map();
    online = false;
    offlineSince = 0;
    lastSearchAt = 0;
    lastDeviceRefreshAt = 0;
    reported = false;
    timer;
    stopped = false;
    constructor(api, log, cfg, opts, store, cached, onIdentified) {
        this.api = api;
        this.log = log;
        this.cfg = cfg;
        this.opts = opts;
        this.store = store;
        this.cached = cached;
        this.onIdentified = onIdentified;
        const remembered = store.get(cfg.host);
        this.bondId = remembered?.bondId;
        this.client = new bondClient_1.BondClient(remembered?.lastHost ?? cfg.host, cfg.token);
    }
    start() {
        void this.tick();
    }
    stop() {
        this.stopped = true;
        if (this.timer) {
            clearTimeout(this.timer);
        }
        this.push?.stop();
        this.devices.forEach(d => d.stop());
    }
    schedule() {
        if (!this.stopped) {
            this.timer = setTimeout(() => void this.tick(), this.opts.pollSeconds * 1000);
        }
    }
    async tick() {
        try {
            if (!this.push) {
                await this.identify();
            }
            if (Date.now() - this.lastDeviceRefreshAt >= DEVICE_REFRESH_MS) {
                await this.refreshDevices();
            }
            else {
                await this.pollStates();
            }
            this.setOnline(true);
        }
        catch (e) {
            if (e instanceof bondClient_1.BondHttpError && e.status === 401) {
                this.log.error(`${this.cfg.name}: the bridge refused the token. Check the token in the plugin settings.`);
            }
            else {
                this.log.debug(`${this.cfg.name}: ${e.message}`);
            }
            this.setOnline(false);
            await this.searchIfLost();
        }
        this.schedule();
    }
    async identify() {
        let version;
        try {
            version = await this.client.version();
        }
        catch (e) {
            // The remembered address may be stale. Try the address typed in the config before giving up.
            if (this.client.host === this.cfg.host) {
                throw e;
            }
            const remembered = this.client.host;
            this.client.host = this.cfg.host;
            try {
                version = await this.client.version();
            }
            catch {
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
        this.push = new bpup_1.PushListener(this.client.host, this.opts.bpupPort, {
            onState: (deviceId, state) => this.devices.get(deviceId)?.updateState(state),
        });
        this.push.start();
        this.onIdentified();
    }
    uuid(deviceId) {
        return this.api.hap.uuid.generate(`bond5m5:${this.bondId}:${deviceId}`);
    }
    async refreshDevices() {
        const index = await this.client.deviceIndex();
        const wanted = Object.keys(index.devices).filter(id => !this.cfg.hideDeviceIds.includes(id));
        const report = [];
        for (const id of wanted) {
            const hash = index.devices[id];
            const existing = this.devices.get(id);
            if (existing && this.hashes.get(id) === hash) {
                existing.updateState(await this.client.state(id));
                continue;
            }
            const device = await this.client.device(id, hash);
            const caps = (0, capabilities_1.mapCapabilities)(device);
            report.push(...(0, capabilities_1.describeDevice)(device, caps));
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
                this.devices.set(id, new deviceAccessory_1.BondDeviceAccessory(accessory, device, deps));
                this.api.updatePlatformAccessories([accessory]);
            }
            else {
                accessory = new this.api.platformAccessory(device.name, uuid);
                accessory.context = { bondId: this.bondId, deviceId: id };
                this.devices.set(id, new deviceAccessory_1.BondDeviceAccessory(accessory, device, deps));
                this.api.registerPlatformAccessories(settings_1.PLUGIN_NAME, settings_1.PLATFORM_NAME, [accessory]);
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
            const ctx = accessory.context;
            if (ctx.bondId === this.bondId && ctx.deviceId && !this.devices.has(ctx.deviceId)) {
                this.api.unregisterPlatformAccessories(settings_1.PLUGIN_NAME, settings_1.PLATFORM_NAME, [accessory]);
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
    remove(id) {
        const dev = this.devices.get(id);
        if (!dev) {
            return;
        }
        dev.stop();
        this.devices.delete(id);
        this.hashes.delete(id);
        this.api.unregisterPlatformAccessories(settings_1.PLUGIN_NAME, settings_1.PLATFORM_NAME, [dev.accessory]);
        this.cached.delete(dev.accessory.UUID);
        this.log.info(`${this.cfg.name}: "${dev.accessory.displayName}" removed from Apple Home.`);
    }
    async pollStates() {
        for (const [id, dev] of this.devices) {
            try {
                dev.updateState(await this.client.state(id));
            }
            catch (e) {
                if (e instanceof bondClient_1.BondHttpError && e.status === 404) {
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
    setOnline(online) {
        if (online === this.online) {
            return;
        }
        this.online = online;
        if (online) {
            if (this.offlineSince) {
                this.log.info(`${this.cfg.name}: the bridge is answering again.`);
            }
            this.offlineSince = 0;
        }
        else {
            this.offlineSince = Date.now();
            this.log.warn(`${this.cfg.name}: the bridge is not answering at ${this.client.host}.`);
        }
        this.devices.forEach(d => d.refresh());
    }
    async searchIfLost() {
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
        const found = await (0, locator_1.locateBridge)(this.bondId, [this.cfg.host, `${this.bondId}.local`], this.client.host);
        if (found && found !== this.client.host) {
            this.log.warn(`${this.cfg.name}: address has changed: ${this.client.host} -> ${found}`);
            this.client.host = found;
            this.push?.setHost(found);
            this.store.set(this.cfg.host, { bondId: this.bondId, lastHost: found });
        }
    }
}
exports.BridgeSession = BridgeSession;
