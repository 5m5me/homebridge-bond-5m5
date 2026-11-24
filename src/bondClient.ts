import http from 'node:http';
import { BondAction, BondDevice, BondState } from './types';

export class BondHttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export interface ClientOptions {
  timeoutMs?: number;
  actionGapMs?: number;
  retries?: number;
}

export function splitHost(host: string): { hostname: string; port: number } {
  const m = /^(.*):(\d+)$/.exec(host.trim());
  return m ? { hostname: m[1], port: Number(m[2]) } : { hostname: host.trim(), port: 80 };
}

/** Sending these twice changes the result, so they are never resent automatically. */
export function isRepeatSafe(action: string): boolean {
  return !/^(Toggle|Increase|Decrease|Cycle|Start)/.test(action);
}

export function rawRequest(
  host: string, method: string, path: string, token: string | undefined, body: unknown, timeoutMs: number,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const { hostname, port } = splitHost(host);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string> = {};
    if (token) {
      headers['BOND-Token'] = token;
    }
    if (payload !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(payload));
    }
    const req = http.request({ hostname, port, path, method, headers, timeout: timeoutMs, agent: false }, res => {
      const chunks: Buffer[] = [];
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
        } catch {
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

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

export class BondClient {
  private chain: Promise<unknown> = Promise.resolve();
  private lastSendAt = 0;
  private readonly timeoutMs: number;
  private readonly actionGapMs: number;
  private readonly retries: number;

  constructor(public host: string, private readonly token: string, opts: ClientOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? 5000;
    this.actionGapMs = opts.actionGapMs ?? 300;
    this.retries = opts.retries ?? 2;
  }

  private async request(method: string, path: string, body: unknown, retries: number): Promise<unknown> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await rawRequest(this.host, method, path, this.token, body, this.timeoutMs);
      } catch (e) {
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
  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      const wait = this.lastSendAt + this.actionGapMs - Date.now();
      if (wait > 0) {
        await sleep(wait);
      }
      try {
        return await job();
      } finally {
        this.lastSendAt = Date.now();
      }
    };
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => undefined);
    return next;
  }

  async version(): Promise<Record<string, unknown>> {
    return await this.request('GET', '/v2/sys/version', undefined, this.retries) as Record<string, unknown>;
  }

  /** Device ids mapped to their change hash, plus the hash of the whole list. */
  async deviceIndex(): Promise<{ listHash: string; devices: Record<string, string> }> {
    const raw = await this.request('GET', '/v2/devices', undefined, this.retries) as Record<string, unknown>;
    const devices: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw)) {
      if (key !== '_' && !key.startsWith('__')) {
        devices[key] = String((value as Record<string, unknown> | null)?._ ?? '');
      }
    }
    return { listHash: String(raw._ ?? ''), devices };
  }

  async device(id: string, hash?: string): Promise<BondDevice> {
    const base = await this.request('GET', `/v2/devices/${id}`, undefined, this.retries) as Record<string, unknown>;
    let properties: Record<string, unknown> = {};
    try {
      properties = await this.request('GET', `/v2/devices/${id}/properties`, undefined, this.retries) as Record<string, unknown>;
    } catch (e) {
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

  async state(id: string): Promise<BondState> {
    return await this.request('GET', `/v2/devices/${id}/state`, undefined, this.retries) as BondState;
  }

  action(id: string, action: BondAction): Promise<void> {
    const body = action.argument === undefined ? {} : { argument: action.argument };
    const retries = isRepeatSafe(action.name) ? this.retries : 0;
    return this.enqueue(async () => {
      await this.request('PUT', `/v2/devices/${id}/actions/${action.name}`, body, retries);
    });
  }

  /** Changes what the bridge believes. Sends no signal to the device. */
  patchState(id: string, patch: BondState): Promise<void> {
    return this.enqueue(async () => {
      await this.request('PATCH', `/v2/devices/${id}/state`, patch, this.retries);
    });
  }
}
