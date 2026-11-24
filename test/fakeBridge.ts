import dgram from 'node:dgram';
import http from 'node:http';
import { AddressInfo } from 'node:net';

export interface FakeDevice {
  name: string;
  type: string;
  template?: string;
  actions: string[];
  properties: Record<string, unknown>;
  state: Record<string, unknown>;
  hash?: string;
}

/** A stand-in Bond Bridge: the local HTTP API plus BPUP push, enough to test against. */
export class FakeBridge {
  devices: Record<string, FakeDevice> = {};
  bondId = 'ZZTEST12345';
  token = 'tok123';
  log: string[] = [];
  failNext = 0;
  private server = http.createServer((req, res) => this.handle(req, res));
  private udp = dgram.createSocket('udp4');
  private subscribers: Array<{ address: string; port: number }> = [];
  port = 0;
  udpPort = 0;

  async start(): Promise<void> {
    await new Promise<void>(r => this.server.listen(0, '127.0.0.1', r));
    this.port = (this.server.address() as AddressInfo).port;
    this.udp.on('message', (_m, rinfo) => {
      this.subscribers.push({ address: rinfo.address, port: rinfo.port });
      this.udp.send(JSON.stringify({ B: this.bondId, d: 0, v: 'v3.0.0' }) + '\n', rinfo.port, rinfo.address);
    });
    await new Promise<void>(r => this.udp.bind(0, '127.0.0.1', r));
    this.udpPort = this.udp.address().port;
  }

  get host(): string {
    return `127.0.0.1:${this.port}`;
  }

  async stop(): Promise<void> {
    this.udp.close();
    await new Promise(r => this.server.close(r));
  }

  pushState(id: string): void {
    const msg = JSON.stringify({ B: this.bondId, d: 0, v: 'v3.0.0', t: `devices/${id}/state`, s: 200, m: 4, b: { _: 'x', ...this.devices[id].state } }) + '\n';
    for (const s of this.subscribers) {
      this.udp.send(msg, s.port, s.address);
    }
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString() || '{}') : {};
      const url = req.url ?? '';
      const send = (status: number, obj: unknown): void => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (this.failNext > 0) {
        this.failNext--;
        req.socket.destroy();
        return;
      }
      if (url === '/v2/sys/version') {
        return send(200, { target: 'zermatt', fw_ver: 'v3.0.0', model: 'BD-1000', bondid: this.bondId });
      }
      if (req.headers['bond-token'] !== this.token) {
        return send(401, {});
      }
      if (url === '/v2/devices') {
        const out: Record<string, unknown> = { _: Object.entries(this.devices).map(([k, d]) => k + (d.hash ?? 'h')).join('') };
        for (const [id, d] of Object.entries(this.devices)) {
          out[id] = { _: d.hash ?? 'h' };
        }
        return send(200, out);
      }
      const m = /^\/v2\/devices\/([^/]+)(?:\/(state|properties|actions)(?:\/(\w+))?)?$/.exec(url);
      const dev = m ? this.devices[m[1]] : undefined;
      if (!m || !dev) {
        return send(404, {});
      }
      const [, id, part, action] = m;
      if (!part) {
        return send(200, { name: dev.name, type: dev.type, template: dev.template, actions: dev.actions, properties: { _: 'p' }, state: { _: 's' } });
      }
      if (part === 'properties') {
        return send(200, { _: 'p', ...dev.properties });
      }
      if (part === 'state' && req.method === 'GET') {
        return send(200, { _: 's', ...dev.state });
      }
      if (part === 'state' && req.method === 'PATCH') {
        this.log.push(`PATCH ${id} ${JSON.stringify(body)}`);
        Object.assign(dev.state, body);
        this.pushState(id);
        return send(200, {});
      }
      if (part === 'actions' && req.method === 'PUT' && action) {
        if (!dev.actions.includes(action)) {
          return send(400, {});
        }
        this.log.push(`${action}${body.argument === undefined ? '' : ` ${body.argument}`}`);
        this.applyAction(dev, action, body.argument);
        this.pushState(id);
        return send(200, {});
      }
      send(404, {});
    });
  }

  private applyAction(dev: FakeDevice, action: string, arg: number): void {
    const s = dev.state;
    switch (action) {
      case 'TurnOn': s.power = 1; break;
      case 'TurnOff': s.power = 0; break;
      case 'TogglePower': s.power = s.power === 1 ? 0 : 1; break;
      case 'SetSpeed': s.power = 1; s.speed = arg; break;
      case 'SetDirection': s.direction = arg; break;
      case 'ToggleDirection': s.direction = s.direction === 1 ? -1 : 1; break;
      case 'TurnLightOn': s.light = 1; break;
      case 'TurnLightOff': s.light = 0; break;
      case 'ToggleLight': s.light = s.light === 1 ? 0 : 1; break;
      case 'SetBrightness': s.light = 1; s.brightness = arg; break;
      case 'BreezeOn': s.breeze = [1, 50, 50]; s.power = 1; break;
      case 'BreezeOff': s.breeze = [0, 50, 50]; break;
      case 'SetTimer': s.timer = arg; break;
    }
  }
}

export const fullFan = (): FakeDevice => ({
  name: 'Lounge Fan', type: 'CF', template: 'A1',
  actions: ['TurnOn', 'TurnOff', 'TogglePower', 'SetSpeed', 'IncreaseSpeed', 'DecreaseSpeed', 'SetDirection', 'ToggleDirection',
    'TurnLightOn', 'TurnLightOff', 'ToggleLight', 'SetBrightness', 'SetTimer'],
  properties: { max_speed: 6, trust_state: false },
  state: { power: 0, speed: 2, direction: 1, light: 0, brightness: 50 },
});

export const toggleFan = (): FakeDevice => ({
  name: 'Bedroom Fan', type: 'CF',
  actions: ['TogglePower', 'SetSpeed', 'ToggleLight', 'StartDimmer', 'Stop', 'ToggleDirection'],
  properties: { max_speed: 3 },
  state: { power: 0, speed: 1, light: 0, direction: 1 },
});

/** A fan like the Devanti remote: six speeds, stop, reverse toggle, breeze, timer, no light, no on button. */
export const devantiFan = (): FakeDevice => ({
  name: 'Office Fan', type: 'CF',
  actions: ['TurnOff', 'SetSpeed', 'ToggleDirection', 'BreezeOn', 'BreezeOff', 'SetTimer'],
  properties: { max_speed: 6 },
  state: { power: 0, speed: 3, direction: 1, timer: 0, breeze: [0, 50, 50] },
});
