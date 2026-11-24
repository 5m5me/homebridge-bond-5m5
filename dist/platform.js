"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.Bond5m5Platform = void 0;
exports.readBridges = readBridges;
exports.readPollSeconds = readPollSeconds;
const node_path_1 = __importDefault(require("node:path"));
const bridge_1 = require("./bridge");
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
class Bond5m5Platform {
    log;
    config;
    api;
    cached = new Map();
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
        api.on('didFinishLaunching', () => this.launch());
        api.on('shutdown', () => this.sessions.forEach(s => s.stop()));
    }
    configureAccessory(accessory) {
        this.cached.set(accessory.UUID, accessory);
    }
    launch() {
        const bridges = readBridges(this.config, m => this.log.warn(m));
        if (!bridges.length) {
            this.log.warn('No Bond Bridge is set up. Add its address and token in the plugin settings.');
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
            const session = new bridge_1.BridgeSession(this.api, this.logger, cfg, options, store, this.cached, () => this.removeOrphans());
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
        const ids = new Set(this.sessions.map(s => s.bondId));
        for (const [uuid, accessory] of [...this.cached]) {
            if (!ids.has(accessory.context.bondId)) {
                this.api.unregisterPlatformAccessories(settings_1.PLUGIN_NAME, settings_1.PLATFORM_NAME, [accessory]);
                this.cached.delete(uuid);
                this.log.info(`Removed "${accessory.displayName}": its bridge is no longer in the settings.`);
            }
        }
    }
}
exports.Bond5m5Platform = Bond5m5Platform;
