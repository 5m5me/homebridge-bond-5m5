"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PushListener = void 0;
exports.parsePush = parsePush;
const node_dgram_1 = __importDefault(require("node:dgram"));
const bondClient_1 = require("./bondClient");
/** Parses one BPUP datagram. Returns nothing for packets that are not device state. */
function parsePush(text) {
    let msg;
    try {
        msg = JSON.parse(text);
    }
    catch {
        return {};
    }
    if (!msg || typeof msg !== 'object') {
        return {};
    }
    const out = {};
    if (typeof msg.B === 'string') {
        out.bondId = msg.B;
    }
    const m = typeof msg.t === 'string' ? /^devices\/([^/]+)\/state$/.exec(msg.t) : null;
    const status = msg.s === undefined ? 200 : Number(msg.s);
    if (m && status >= 200 && status < 300 && msg.b && typeof msg.b === 'object') {
        out.deviceId = m[1];
        out.state = msg.b;
    }
    return out;
}
/** Listens for the bridge's push updates (BPUP). Keeps the subscription alive. */
class PushListener {
    host;
    port;
    handlers;
    keepAliveMs;
    socket;
    timer;
    lastHeardAt = 0;
    constructor(host, port, handlers, keepAliveMs = 60000) {
        this.host = host;
        this.port = port;
        this.handlers = handlers;
        this.keepAliveMs = keepAliveMs;
    }
    setHost(host) {
        this.host = host;
        this.keepAlive();
    }
    start() {
        const socket = node_dgram_1.default.createSocket('udp4');
        this.socket = socket;
        socket.on('error', () => undefined);
        socket.on('message', buf => {
            this.lastHeardAt = Date.now();
            for (const line of buf.toString('utf8').split('\n')) {
                if (!line.trim()) {
                    continue;
                }
                const p = parsePush(line);
                if (p.bondId) {
                    this.handlers.onBondId?.(p.bondId);
                }
                if (p.deviceId && p.state) {
                    this.handlers.onState(p.deviceId, p.state);
                }
            }
        });
        socket.bind(() => this.keepAlive());
        this.timer = setInterval(() => this.keepAlive(), this.keepAliveMs);
        this.timer.unref();
    }
    keepAlive() {
        try {
            this.socket?.send('\n', this.port, (0, bondClient_1.splitHost)(this.host).hostname, () => undefined);
        }
        catch {
            // The socket is closed or the address is bad. The next keep-alive tries again.
        }
    }
    stop() {
        if (this.timer) {
            clearInterval(this.timer);
        }
        try {
            this.socket?.close();
        }
        catch {
            // already closed
        }
        this.socket = undefined;
    }
}
exports.PushListener = PushListener;
