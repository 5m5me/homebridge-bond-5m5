"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.BondClient = exports.BondHttpError = void 0;
exports.splitHost = splitHost;
exports.isRepeatSafe = isRepeatSafe;
exports.rawRequest = rawRequest;
const node_http_1 = __importDefault(require("node:http"));
class BondHttpError extends Error {
    status;
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}
exports.BondHttpError = BondHttpError;
function splitHost(host) {
    const m = /^(.*):(\d+)$/.exec(host.trim());
    return m ? { hostname: m[1], port: Number(m[2]) } : { hostname: host.trim(), port: 80 };
}
/** Sending these twice changes the result, so they are never resent automatically. */
function isRepeatSafe(action) {
    return !/^(Toggle|Increase|Decrease|Cycle|Start)/.test(action);
}
function rawRequest(host, method, path, token, body, timeoutMs) {
    return new Promise((resolve, reject) => {
        const { hostname, port } = splitHost(host);
        const payload = body === undefined ? undefined : JSON.stringify(body);
        const headers = {};
        if (token) {
            headers['BOND-Token'] = token;
        }
        if (payload !== undefined) {
            headers['Content-Type'] = 'application/json';
            headers['Content-Length'] = String(Buffer.byteLength(payload));
        }
        const req = node_http_1.default.request({ hostname, port, path, method, headers, timeout: timeoutMs, agent: false }, res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('error', reject);
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                const status = res.statusCode ?? 0;
                if (status < 200 || status >= 300) {
                    reject(new BondHttpError(status, `Bond answered ${status} to ${method} ${path}`));
                    return;
                }
                if (!text.trim()) {
                    resolve({});
                    return;
                }
                try {
                    resolve(JSON.parse(text));
                }
                catch {
                    reject(new Error(`Bond sent an unreadable answer to ${method} ${path}`));
                }
            });
        });
        req.on('timeout', () => req.destroy(new Error(`No answer from Bond at ${host} within ${timeoutMs} ms`)));
        req.on('error', reject);
        if (payload !== undefined) {
            req.write(payload);
        }
        req.end();
    });
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
class BondClient {
    host;
    token;
    chain = Promise.resolve();
    lastSendAt = 0;
    timeoutMs;
    actionGapMs;
    retries;
    constructor(host, token, opts = {}) {
        this.host = host;
        this.token = token;
        this.timeoutMs = opts.timeoutMs ?? 5000;
        this.actionGapMs = opts.actionGapMs ?? 300;
        this.retries = opts.retries ?? 2;
    }
    async request(method, path, body, retries) {
        let lastError;
        for (let attempt = 0; attempt <= retries; attempt++) {
            try {
                return await rawRequest(this.host, method, path, this.token, body, this.timeoutMs);
            }
            catch (e) {
                lastError = e;
                if (e instanceof BondHttpError && e.status >= 400 && e.status < 500) {
                    break; // the bridge understood and refused. Asking again will not help.
                }
                if (attempt < retries) {
                    await sleep(250 * (attempt + 1));
                }
            }
        }
        throw lastError;
    }
    /** Runs one at a time with a gap, because the bridge transmits one signal at a time. */
    enqueue(job) {
        const run = async () => {
            const wait = this.lastSendAt + this.actionGapMs - Date.now();
            if (wait > 0) {
                await sleep(wait);
            }
            try {
                return await job();
            }
            finally {
                this.lastSendAt = Date.now();
            }
        };
        const next = this.chain.then(run, run);
        this.chain = next.catch(() => undefined);
        return next;
    }
    async version() {
        return await this.request('GET', '/v2/sys/version', undefined, this.retries);
    }
    /** Device ids mapped to their change hash, plus the hash of the whole list. */
    async deviceIndex() {
        const raw = await this.request('GET', '/v2/devices', undefined, this.retries);
        const devices = {};
        for (const [key, value] of Object.entries(raw)) {
            if (key !== '_' && !key.startsWith('__')) {
                devices[key] = String(value?._ ?? '');
            }
        }
        return { listHash: String(raw._ ?? ''), devices };
    }
    async device(id, hash) {
        const base = await this.request('GET', `/v2/devices/${id}`, undefined, this.retries);
        let properties = {};
        try {
            properties = await this.request('GET', `/v2/devices/${id}/properties`, undefined, this.retries);
        }
        catch (e) {
            if (!(e instanceof BondHttpError)) {
                throw e;
            }
        }
        const state = await this.state(id);
        return {
            id,
            name: String(base.name ?? id),
            type: String(base.type ?? ''),
            location: base.location === undefined ? undefined : String(base.location),
            template: base.template === undefined ? undefined : String(base.template),
            actions: Array.isArray(base.actions) ? base.actions.map(String) : [],
            properties,
            state,
            hash,
        };
    }
    async state(id) {
        return await this.request('GET', `/v2/devices/${id}/state`, undefined, this.retries);
    }
    action(id, action) {
        const body = action.argument === undefined ? {} : { argument: action.argument };
        const retries = isRepeatSafe(action.name) ? this.retries : 0;
        return this.enqueue(async () => {
            await this.request('PUT', `/v2/devices/${id}/actions/${action.name}`, body, retries);
        });
    }
    /** Changes what the bridge believes. Sends no signal to the device. */
    patchState(id, patch) {
        return this.enqueue(async () => {
            await this.request('PATCH', `/v2/devices/${id}/state`, patch, this.retries);
        });
    }
}
exports.BondClient = BondClient;
