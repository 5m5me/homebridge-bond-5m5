import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { API, PlatformAccessory } from 'homebridge';
import { Bond5m5Platform } from '../src/platform';
import { FakeBridge, devantiFan, fullFan, toggleFan } from './fakeBridge';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { HomebridgeAPI } = require('homebridge/lib/api');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { User } = require('homebridge/lib/user');

const STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), 'bond-hb-'));
User.setStoragePath(STORAGE);

const wait = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

interface Rig {
  bridge: FakeBridge;
  api: API;
  accessories: Map<string, PlatformAccessory>;
  logs: string[];
  stop(): Promise<void>;
}

async function rig(extra: Record<string, unknown> = {}, setup?: (b: FakeBridge) => void): Promise<Rig> {
  const bridge = new FakeBridge();
  bridge.devices.fan1 = fullFan();
  bridge.devices.fan2 = toggleFan();
  setup?.(bridge);
  await bridge.start();
  const api = new HomebridgeAPI() as API;
  const accessories = new Map<string, PlatformAccessory>();
  api.on('registerPlatformAccessories' as never, ((list: PlatformAccessory[]) => list.forEach(a => accessories.set(a.displayName, a))) as never);
  api.on('unregisterPlatformAccessories' as never, ((list: PlatformAccessory[]) => list.forEach(a => accessories.delete(a.displayName))) as never);
  const logs: string[] = [];
  const logFn = (m: string): void => { logs.push(m); };
  const log = Object.assign(logFn, { info: logFn, warn: logFn, error: logFn, debug: () => undefined, success: logFn, log: logFn, prefix: 't' });
  new Bond5m5Platform(log as never, {
    platform: 'Bond5m5', bridges: [{ host: bridge.host, token: bridge.token }], bpupPort: bridge.udpPort, pollSeconds: 5, ...extra,
  } as never, api);
  (api as unknown as { emit(e: string): void }).emit('didFinishLaunching');
  await wait(500);
  return {
    bridge, api, accessories, logs,
    stop: async () => {
      (api as unknown as { emit(e: string): void }).emit('shutdown');
      await bridge.stop();
    },
  };
}

function svc(r: Rig, name: string, kind: 'Fanv2' | 'Lightbulb' | 'Switch', subtype: string) {
  const s = r.accessories.get(name)!.getServiceById(r.api.hap.Service[kind], subtype);
  assert.ok(s, `${name} has ${kind}/${subtype}`);
  return s;
}

async function set(r: Rig, s: ReturnType<typeof svc>, ch: keyof API['hap']['Characteristic'], value: unknown): Promise<void> {
  await (s.getCharacteristic(r.api.hap.Characteristic[ch] as never) as unknown as { handleSetRequest(v: unknown): Promise<void> }).handleSetRequest(value);
}

const val = (r: Rig, s: ReturnType<typeof svc>, ch: keyof API['hap']['Characteristic']): unknown =>
  s.getCharacteristic(r.api.hap.Characteristic[ch] as never).value;

test('both fans appear with the right tiles and a startup report', async () => {
  const r = await rig();
  try {
    assert.deepEqual([...r.accessories.keys()].sort(), ['Bedroom Fan', 'Lounge Fan']);
    const C = r.api.hap.Characteristic;
    const lounge = svc(r, 'Lounge Fan', 'Fanv2', 'fan');
    assert.ok(lounge.testCharacteristic(C.RotationSpeed));
    assert.ok(lounge.testCharacteristic(C.RotationDirection));
    assert.ok(Math.abs(lounge.getCharacteristic(C.RotationSpeed).props.minStep! - 100 / 6) < 0.001);
    assert.ok(svc(r, 'Lounge Fan', 'Lightbulb', 'light').testCharacteristic(C.Brightness));
    assert.equal(r.accessories.get('Lounge Fan')!.getServiceById(r.api.hap.Service.Switch, 'dimmer'), undefined);
    assert.equal(r.accessories.get('Lounge Fan')!.getServiceById(r.api.hap.Service.Switch, 'correct'), undefined);
    assert.equal(svc(r, 'Bedroom Fan', 'Lightbulb', 'light').testCharacteristic(C.Brightness), false);
    svc(r, 'Bedroom Fan', 'Switch', 'dimmer');
    assert.ok(r.logs.some(l => l.includes('connected to Bond ZZTEST12345')));
    assert.ok(r.logs.some(l => l.includes('Fan speeds: 6')));
    assert.ok(r.logs.some(l => l.includes('hold-to-dim')));
  } finally {
    await r.stop();
  }
});

test('Apple Home commands reach the fan and the tile follows the bridge', async () => {
  const r = await rig();
  try {
    const C = r.api.hap.Characteristic;
    const fan = svc(r, 'Lounge Fan', 'Fanv2', 'fan');
    // Home sends power and speed together when a fan is switched on from the slider.
    await set(r, fan, 'Active', 1);
    await set(r, fan, 'RotationSpeed', 66.67);
    await wait(600);
    assert.deepEqual(r.bridge.log, ['SetSpeed 4']);
    assert.equal(val(r, fan, 'Active'), 1);
    await set(r, fan, 'RotationDirection', C.RotationDirection.CLOCKWISE);
    await wait(500);
    assert.equal(r.bridge.log.at(-1), 'SetDirection -1');
    const light = svc(r, 'Lounge Fan', 'Lightbulb', 'light');
    await set(r, light, 'On', true);
    await set(r, light, 'Brightness', 80);
    await wait(900);
    assert.deepEqual(r.bridge.log.slice(-2), ['TurnLightOn', 'SetBrightness 80']);
    await set(r, fan, 'Active', 0);
    await wait(500);
    assert.equal(r.bridge.log.at(-1), 'TurnOff');
    assert.equal(val(r, fan, 'RotationSpeed'), 0);

    // Someone uses the Bond app: the bridge pushes the change and the tile follows without a command.
    const before = r.bridge.log.length;
    r.bridge.devices.fan1.state.power = 1;
    r.bridge.devices.fan1.state.speed = 6;
    r.bridge.pushState('fan1');
    await wait(200);
    assert.equal(val(r, fan, 'Active'), 1);
    assert.equal(val(r, fan, 'RotationSpeed'), 100);
    assert.equal(r.bridge.log.length, before);
  } finally {
    await r.stop();
  }
});

test('toggle-only fan: no toggle is sent when the tile already matches', async () => {
  const r = await rig();
  try {
    const fan = svc(r, 'Bedroom Fan', 'Fanv2', 'fan');
    await set(r, fan, 'Active', 1);
    await wait(500);
    assert.deepEqual(r.bridge.log, ['TogglePower']);
    await set(r, fan, 'Active', 1);
    await wait(500);
    assert.deepEqual(r.bridge.log, ['TogglePower']);
    const dimmer = svc(r, 'Bedroom Fan', 'Switch', 'dimmer');
    await set(r, dimmer, 'On', true);
    await set(r, dimmer, 'On', false);
    await wait(800);
    assert.deepEqual(r.bridge.log.slice(-2), ['StartDimmer', 'Stop']);
  } finally {
    await r.stop();
  }
});

test('Correct State fixes the tile and sends no signal', async () => {
  const r = await rig({ correctStateSwitch: true });
  try {
    const fan = svc(r, 'Bedroom Fan', 'Fanv2', 'fan');
    await set(r, svc(r, 'Bedroom Fan', 'Switch', 'correct'), 'On', true);
    await set(r, fan, 'Active', 1);
    await wait(500);
    assert.deepEqual(r.bridge.log, ['PATCH fan2 {"power":1}']);
    assert.equal(r.bridge.devices.fan2.state.power, 1);
    assert.equal(val(r, fan, 'Active'), 1);
    await set(r, svc(r, 'Bedroom Fan', 'Switch', 'correct'), 'On', false);
    await set(r, fan, 'Active', 0);
    await wait(500);
    assert.equal(r.bridge.log.at(-1), 'TogglePower');
  } finally {
    await r.stop();
  }
});

test('tiles show No Response when the bridge stops answering', async () => {
  const r = await rig();
  try {
    const fan = svc(r, 'Lounge Fan', 'Fanv2', 'fan');
    const active = fan.getCharacteristic(r.api.hap.Characteristic.Active) as unknown as { handleGetRequest(): Promise<unknown> };
    assert.equal(await active.handleGetRequest(), 0);
    await r.bridge.stop();
    await wait(7500);
    await assert.rejects(active.handleGetRequest());
    assert.ok(r.logs.some(l => l.includes('not answering')));
  } finally {
    (r.api as unknown as { emit(e: string): void }).emit('shutdown');
  }
});

test('hidden and unsupported devices are not shown, wrong token is explained', async () => {
  const r = await rig({}, b => {
    b.devices.fire = { name: 'Fireplace', type: 'FP', actions: ['TurnOn', 'TurnOff'], properties: {}, state: {} };
  });
  try {
    assert.deepEqual([...r.accessories.keys()].sort(), ['Bedroom Fan', 'Lounge Fan']);
    assert.ok(r.logs.some(l => l.includes('Not shown in Apple Home')));
  } finally {
    await r.stop();
  }
  const bridge = new FakeBridge();
  bridge.devices.fan1 = fullFan();
  await bridge.start();
  const api = new HomebridgeAPI() as API;
  const logs: string[] = [];
  const logFn = (m: string): void => { logs.push(m); };
  const log = Object.assign(logFn, { info: logFn, warn: logFn, error: logFn, debug: () => undefined });
  new Bond5m5Platform(log as never, { platform: 'Bond5m5', bridges: [{ host: bridge.host, token: 'wrong', hideDeviceIds: ['fan1'] }], bpupPort: bridge.udpPort } as never, api);
  (api as unknown as { emit(e: string): void }).emit('didFinishLaunching');
  await wait(400);
  (api as unknown as { emit(e: string): void }).emit('shutdown');
  await bridge.stop();
  assert.ok(logs.some(l => l.includes('refused the token')));
});

test('Devanti-style fan: one fan tile, breeze and four timer switches, no light', async () => {
  const r = await rig({}, b => { b.devices.fan3 = devantiFan(); });
  try {
    const S = r.api.hap.Service;
    const acc = r.accessories.get('Office Fan')!;
    assert.equal(acc.services.filter(s => s.UUID === S.Lightbulb.UUID).length, 0);
    assert.deepEqual(acc.services.filter(s => s.UUID === S.Switch.UUID).map(s => s.subtype).sort(),
      ['breeze', 'timer-1', 'timer-2', 'timer-4', 'timer-8']);
    const fan = svc(r, 'Office Fan', 'Fanv2', 'fan');
    await set(r, fan, 'Active', 1);
    await wait(500);
    assert.deepEqual(r.bridge.log, ['SetSpeed 3']);
    await set(r, svc(r, 'Office Fan', 'Switch', 'timer-2'), 'On', true);
    await wait(500);
    assert.equal(r.bridge.log.at(-1), 'SetTimer 7200');
    assert.equal(val(r, svc(r, 'Office Fan', 'Switch', 'timer-2'), 'On'), true);
    assert.equal(val(r, svc(r, 'Office Fan', 'Switch', 'timer-1'), 'On'), false);
    // Picking a different timer replaces the first one.
    await set(r, svc(r, 'Office Fan', 'Switch', 'timer-4'), 'On', true);
    await wait(500);
    assert.equal(r.bridge.log.at(-1), 'SetTimer 14400');
    assert.equal(val(r, svc(r, 'Office Fan', 'Switch', 'timer-2'), 'On'), false);
    assert.equal(val(r, svc(r, 'Office Fan', 'Switch', 'timer-4'), 'On'), true);
    await set(r, svc(r, 'Office Fan', 'Switch', 'timer-4'), 'On', false);
    await wait(500);
    assert.equal(r.bridge.log.at(-1), 'SetTimer 0');
    assert.equal(val(r, svc(r, 'Office Fan', 'Switch', 'timer-4'), 'On'), false);
    const breeze = svc(r, 'Office Fan', 'Switch', 'breeze');
    await set(r, breeze, 'On', true);
    await wait(500);
    assert.equal(r.bridge.log.at(-1), 'BreezeOn');
    assert.equal(val(r, breeze, 'On'), true);
    await set(r, fan, 'Active', 0);
    await wait(500);
    assert.equal(r.bridge.log.at(-1), 'TurnOff');
    assert.equal(val(r, breeze, 'On'), false);
  } finally {
    await r.stop();
  }
});

test('breeze and timer switches can be turned off in the settings', async () => {
  const r = await rig({ breezeSwitch: false, timerSwitches: false }, b => { b.devices.fan3 = devantiFan(); });
  try {
    const S = r.api.hap.Service;
    assert.equal(r.accessories.get('Office Fan')!.services.filter(s => s.UUID === S.Switch.UUID).length, 0);
  } finally {
    await r.stop();
  }
});
