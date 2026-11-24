import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { BondClient, BondHttpError, isRepeatSafe, splitHost } from '../src/bondClient';
import { PushListener, parsePush } from '../src/bpup';
import { isPrivateIPv4, locateBridge, scanTargets } from '../src/locator';
import { readBridges, readPollSeconds } from '../src/platform';
import { BridgeStore } from '../src/store';
import { FakeBridge, fullFan } from './fakeBridge';

const wait = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

async function withBridge(fn: (b: FakeBridge) => Promise<void>): Promise<void> {
  const b = new FakeBridge();
  b.devices.abc = fullFan();
  await b.start();
  try {
    await fn(b);
  } finally {
    await b.stop();
  }
}

test('client reads version, device list, device and state', () => withBridge(async b => {
  const c = new BondClient(b.host, b.token, { actionGapMs: 0 });
  assert.equal((await c.version()).bondid, 'ZZTEST12345');
  const idx = await c.deviceIndex();
  assert.deepEqual(Object.keys(idx.devices), ['abc']);
  const d = await c.device('abc', idx.devices.abc);
  assert.equal(d.name, 'Lounge Fan');
  assert.equal(d.properties.max_speed, 6);
  assert.equal(d.state.speed, 2);
  assert.ok(d.actions.includes('SetSpeed'));
}));

test('client sends actions in order with arguments, and patches state without an action', () => withBridge(async b => {
  const c = new BondClient(b.host, b.token, { actionGapMs: 0 });
  await Promise.all([c.action('abc', { name: 'SetSpeed', argument: 4 }), c.action('abc', { name: 'TurnLightOn' }), c.action('abc', { name: 'TurnOff' })]);
  assert.deepEqual(b.log, ['SetSpeed 4', 'TurnLightOn', 'TurnOff']);
  await c.patchState('abc', { power: 1 });
  assert.equal(b.log.at(-1), 'PATCH abc {"power":1}');
  assert.equal((await c.state('abc')).power, 1);
}));

test('client spaces actions out', () => withBridge(async b => {
  const c = new BondClient(b.host, b.token, { actionGapMs: 120 });
  const t = Date.now();
  await Promise.all([c.action('abc', { name: 'TurnOn' }), c.action('abc', { name: 'TurnOff' }), c.action('abc', { name: 'TurnOn' })]);
  assert.ok(Date.now() - t >= 230, 'three actions take at least two gaps');
}));

test('wrong token is reported and not retried', () => withBridge(async b => {
  const c = new BondClient(b.host, 'bad', { actionGapMs: 0 });
  await assert.rejects(c.deviceIndex(), (e: unknown) => e instanceof BondHttpError && e.status === 401);
}));

test('a dropped connection is retried for safe actions but never for toggles', () => withBridge(async b => {
  const c = new BondClient(b.host, b.token, { actionGapMs: 0 });
  b.failNext = 1;
  await c.action('abc', { name: 'TurnOn' });
  assert.deepEqual(b.log, ['TurnOn']);
  b.failNext = 1;
  await assert.rejects(c.action('abc', { name: 'TogglePower' }));
  assert.deepEqual(b.log, ['TurnOn']);
  assert.equal(isRepeatSafe('SetSpeed'), true);
  assert.equal(isRepeatSafe('ToggleLight'), false);
  assert.equal(isRepeatSafe('StartDimmer'), false);
  assert.equal(isRepeatSafe('IncreaseSpeed'), false);
}));

test('an unreachable bridge fails with an error, not a hang', async () => {
  const c = new BondClient('127.0.0.1:1', 'x', { retries: 0, timeoutMs: 500 });
  await assert.rejects(c.version());
});

test('host parsing', () => {
  assert.deepEqual(splitHost('192.168.55.30'), { hostname: '192.168.55.30', port: 80 });
  assert.deepEqual(splitHost('192.168.55.30:8080'), { hostname: '192.168.55.30', port: 8080 });
  assert.deepEqual(splitHost(' zzbl1.local '), { hostname: 'zzbl1.local', port: 80 });
});

test('push packets are parsed, junk is ignored', () => {
  assert.deepEqual(parsePush('{"B":"ZZ1"}'), { bondId: 'ZZ1' });
  assert.deepEqual(parsePush('{"B":"ZZ1","t":"devices/ab12/state","s":200,"b":{"power":1}}'), { bondId: 'ZZ1', deviceId: 'ab12', state: { power: 1 } });
  assert.deepEqual(parsePush('{"B":"ZZ1","t":"devices/ab12/state","s":500,"b":{"power":1}}'), { bondId: 'ZZ1' });
  assert.deepEqual(parsePush('{"B":"ZZ1","t":"devices/ab12/actions/TurnOn","s":200,"b":{}}'), { bondId: 'ZZ1' });
  assert.deepEqual(parsePush('not json'), {});
  assert.deepEqual(parsePush('null'), {});
});

test('push listener subscribes and receives live state', () => withBridge(async b => {
  const seen: string[] = [];
  let id = '';
  const p = new PushListener(b.host, b.udpPort, { onState: (d, s) => seen.push(`${d}:${s.power}`), onBondId: v => { id = v; } });
  p.start();
  await wait(150);
  assert.equal(id, 'ZZTEST12345');
  const c = new BondClient(b.host, b.token, { actionGapMs: 0 });
  await c.action('abc', { name: 'TurnOn' });
  await wait(150);
  p.stop();
  assert.deepEqual(seen, ['abc:1']);
}));

test('network search targets', () => {
  assert.equal(isPrivateIPv4('192.168.55.30'), true);
  assert.equal(isPrivateIPv4('10.1.2.3'), true);
  assert.equal(isPrivateIPv4('172.20.0.1'), true);
  assert.equal(isPrivateIPv4('172.32.0.1'), false);
  assert.equal(isPrivateIPv4('8.8.8.8'), false);
  assert.equal(isPrivateIPv4('bond.local'), false);
  const t = scanTargets('192.168.55.30');
  assert.equal(t.length, 254);
  assert.equal(t[0], '192.168.55.1');
  assert.equal(t[253], '192.168.55.254');
  assert.deepEqual(scanTargets('8.8.8.8'), []);
  assert.deepEqual(scanTargets('bond.local'), []);
});

test('a moved bridge is found by its Bond ID, others are ignored', async () => {
  const probed: string[] = [];
  const probe = async (h: string): Promise<string | undefined> => {
    probed.push(h);
    return h === '192.168.55.77' ? 'zzabc' : h === '192.168.55.20' ? 'OTHER' : undefined;
  };
  assert.equal(await locateBridge('ZZABC', ['192.168.55.30', 'ZZABC.local'], '192.168.55.30', probe), '192.168.55.77');
  assert.equal(probed[0], '192.168.55.30');
  assert.equal(await locateBridge('ZZABC', ['192.168.55.77'], '192.168.55.30', probe), '192.168.55.77');
  assert.equal(await locateBridge('NOPE', [], '192.168.55.30', probe), undefined);
  assert.equal(await locateBridge('ZZABC', [], '8.8.8.8', probe), undefined);
});

test('store remembers bridges and only writes on change', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bond-')), 's.json');
  const s = new BridgeStore(file);
  assert.equal(s.get('a'), undefined);
  s.set('a', { bondId: 'ZZ1', lastHost: '1.2.3.4' });
  const m1 = fs.statSync(file).mtimeMs;
  fs.utimesSync(file, new Date(0), new Date(0));
  s.set('a', { bondId: 'ZZ1', lastHost: '1.2.3.4' });
  assert.equal(fs.statSync(file).mtimeMs, 0, 'unchanged record is not rewritten');
  assert.ok(m1 > 0);
  assert.deepEqual(new BridgeStore(file).get('a'), { bondId: 'ZZ1', lastHost: '1.2.3.4' });
  fs.writeFileSync(file, 'garbage');
  assert.equal(new BridgeStore(file).get('a'), undefined);
});

test('settings are read defensively', () => {
  const warns: string[] = [];
  const b = readBridges({ bridges: [
    { host: ' http://192.168.55.30/ ', token: ' t ', hideDeviceIds: ['x', ' '] },
    { host: '192.168.55.30', token: 't2' },
    { host: '', token: 't' },
    null,
    { name: 'Shed', host: '192.168.55.31', token: 't' },
  ] }, m => warns.push(m));
  assert.deepEqual(b, [
    { name: 'Bond 1', host: '192.168.55.30', token: 't', hideDeviceIds: ['x'] },
    { name: 'Shed', host: '192.168.55.31', token: 't', hideDeviceIds: [] },
  ]);
  assert.equal(warns.length, 3);
  assert.deepEqual(readBridges({}, () => undefined), []);
  assert.equal(readPollSeconds('20'), 20);
  assert.equal(readPollSeconds(undefined), 30);
  assert.equal(readPollSeconds(1), 30);
  assert.equal(readPollSeconds(99999), 600);
});
