import dgram from 'node:dgram';
import { splitHost } from './bondClient';
import { BondState } from './types';

export interface PushHandlers {
  onState(deviceId: string, state: BondState): void;
  onBondId?(bondId: string): void;
}

/** Parses one BPUP datagram. Returns nothing for packets that are not device state. */
export function parsePush(text: string): { bondId?: string; deviceId?: string; state?: BondState } {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
  if (!msg || typeof msg !== 'object') {
    return {};
  }
  const out: { bondId?: string; deviceId?: string; state?: BondState } = {};
  if (typeof msg.B === 'string') {
    out.bondId = msg.B;
  }
  const m = typeof msg.t === 'string' ? /^devices\/([^/]+)\/state$/.exec(msg.t) : null;
  const status = msg.s === undefined ? 200 : Number(msg.s);
  if (m && status >= 200 && status < 300 && msg.b && typeof msg.b === 'object') {
    out.deviceId = m[1];
    out.state = msg.b as BondState;
  }
  return out;
}

/** Listens for the bridge's push updates (BPUP). Keeps the subscription alive. */
export class PushListener {
  private socket?: dgram.Socket;
  private timer?: NodeJS.Timeout;
  lastHeardAt = 0;

  constructor(private host: string, private readonly port: number, private readonly handlers: PushHandlers,
    private readonly keepAliveMs = 60000) {}

  setHost(host: string): void {
    this.host = host;
    this.keepAlive();
  }

  start(): void {
    const socket = dgram.createSocket('udp4');
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

  private keepAlive(): void {
    try {
      this.socket?.send('\n', this.port, splitHost(this.host).hostname, () => undefined);
    } catch {
      // The socket is closed or the address is bad. The next keep-alive tries again.
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
    try {
      this.socket?.close();
    } catch {
      // already closed
    }
    this.socket = undefined;
  }
}
