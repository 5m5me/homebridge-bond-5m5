"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.Bond5m5Platform = void 0;
exports.readBridges = readBridges;
exports.readPollSeconds = readPollSeconds;
exports.chooseConnection = chooseConnection;
const node_path_1 = __importDefault(require("node:path"));
const bridge_1 = require("./bridge");
const hapPublisher_1 = require("./hapPublisher");
const matterPublisher_1 = require("./matterPublisher");
const settings_1 = require("./settings");
const store_1 = require("./store");
function readBridges(config, warn) {
    const out = [];
    const list = Array.isArray(config.bridges) ? config.bridges : [];
    list.forEach((raw, i) => {
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
function readPollSeconds(value) {
    const n = Number(value);
    return Number.isFinite(n) && n >= 5 ? Math.min(Math.round(n), 600) : 30;
}
/** Decides which connection carries the devices. They are never published over both, or every tile would appear twice. */
function chooseConnection(setting, matterOn, hapOn, warn) {
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
class Bond5m5Platform {
    log;
    config;
    api;
    hap;
    matterCache = new Map();
    publisher;
    sessions = [];
    logger;
    constructor(log, config, api) {
        this.log = log;
        this.config = config;
        this.api = api;
        const debug = config.debug === true;
        this.logger = {
            info: m => log.info(m),
            warn: m => log.warn(m),
            error: m => log.error(m),
            debug: m => (debug ? log.info(`[debug] ${m}`) : log.debug(m)),
        };
        this.hap = new hapPublisher_1.HapPublisher(api);
        api.on('didFinishLaunching', () => void this.launch());
        api.on('shutdown', () => this.sessions.forEach(s => s.stop()));
    }
    configureAccessory(accessory) {
        this.hap.cached.set(accessory.UUID, accessory);
    }
    /** Homebridge 2 hands back the Matter accessories it remembered. */
    configureMatterAccessory(accessory) {
        this.matterCache.set(accessory.UUID, accessory);
    }
    async launch() {
        const bridges = readBridges(this.config, m => this.log.warn(m));
        if (!bridges.length) {
            this.log.warn('No Bond Bridge is set up. Add its address and token in the plugin settings.');
        }
        const maybe = this.api;
        const matterOn = typeof maybe.isMatterEnabled === 'function' && maybe.isMatterEnabled() && !!maybe.matter;
        const hapOn = typeof maybe.isHapEnabled === 'function' ? maybe.isHapEnabled() : true;
        const connection = chooseConnection(this.config.connection, matterOn, hapOn, m => this.log.warn(m));
        const matter = matterOn
            ? new matterPublisher_1.MatterPublisher(maybe.matter, this.logger, this.matterCache, seed => this.api.hap.uuid.generate(seed), this.config.matterSpeedSteps !== false)
            : undefined;
        this.publisher = connection === 'matter' ? matter : this.hap;
        const other = connection === 'matter' ? this.hap : matter;
        this.log.info(`Devices are published over ${this.publisher.label}.`
            + (connection === 'homekit' && !hapOn ? ' HomeKit (HAP) is switched off for this bridge, so nothing will show until it is switched on.' : ''));
        try {
            const removed = other ? await other.removeAll() : 0;
            if (removed) {
                this.log.info(`Removed ${removed} device(s) from ${other.label} so nothing shows twice.`);
            }
        }
        catch (e) {
            this.log.warn(`Could not clear the ${other.label} side: ${e.message}`);
        }
        const store = new store_1.BridgeStore(node_path_1.default.join(this.api.user.storagePath(), 'bond-5m5-bridges.json'));
        const options = {
            pollSeconds: readPollSeconds(this.config.pollSeconds),
            correctStateSwitch: this.config.correctStateSwitch === true,
            dimmerSwitch: this.config.dimmerSwitch !== false,
            breezeSwitch: this.config.breezeSwitch !== false,
            timerHours: this.config.timerSwitches === false ? [] : [1, 2, 4, 8],
            bpupPort: Number(this.config.bpupPort) > 0 ? Number(this.config.bpupPort) : settings_1.BPUP_PORT,
        };
        for (const cfg of bridges) {
            const session = new bridge_1.BridgeSession(this.logger, cfg, options, store, this.publisher, () => this.removeOrphans());
            this.sessions.push(session);
            session.start();
        }
        this.removeOrphans();
    }
    /** Removes tiles that belong to a bridge no longer in the settings. Waits until every bridge is identified. */
    removeOrphans() {
        if (this.sessions.some(s => !s.bondId)) {
            return;
        }
        const ids = this.sessions.map(s => s.bondId);
        this.publisher.removeOrphans(ids).catch(e => this.log.warn(`Could not remove old devices: ${e.message}`));
    }
}
exports.Bond5m5Platform = Bond5m5Platform;
