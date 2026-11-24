import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { API, PlatformAccessory } from 'homebridge';
import { MatterAccessoryLike, MatterApiLike, fanModeFor, levelFromPercent, multiSpeedFan, percentFromLevel } from '../src/matterPublisher';
import { Bond5m5Platform, chooseConnection } from '../src/platform';
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

async function rig(extra: Record<string, unknown> = {}, setup?: (b: FakeBridge) => void, prepare?: (api: API) => void): Promise<Rig> {
  const bridge = new FakeBridge();
  bridge.devices.fan1 = fullFan();
  bridge.devices.fan2 = toggleFan();
  setup?.(bridge);
  await bridge.start();
  const api = new HomebridgeAPI() as API;
  prepare?.(api);
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

/** Stand-in for Homebridge 2's Matter interface. Like the real one, it reports fan state changes back as commands. */
class FakeMatter implements MatterApiLike {
  deviceTypes = { Fan: 'Fan', OnOffOutlet: 'OnOffOutlet', OnOffLight: 'OnOffLight', DimmableLight: 'DimmableLight' };
  accessories = new Map<string, MatterAccessoryLike>();
  state = new Map<string, Record<string, unknown>>();
  unregistered: string[] = [];
  async registerPlatformAccessories(_p: string, _n: string, list: MatterAccessoryLike[]): Promise<void> {
    for (const a of list) {
      this.accessories.set(a.UUID, a);
      for (const [cluster, attrs] of Object.entries(a.clusters ?? {})) {
        this.state.set(`${a.UUID}|${cluster}`, { ...attrs });
      }
    }
  }
  async unregisterPlatformAccessories(_p: string, _n: string, list: MatterAccessoryLike[]): Promise<void> {
    list.forEach(a => { this.accessories.delete(a.UUID); this.unregistered.push(a.displayName); });
  }
  async updateAccessoryState(uuid: string, cluster: string, attributes: Record<string, unknown>): Promise<void> {
    const key = `${uuid}|${cluster}`;
    const old = this.state.get(key) ?? {};
    this.state.set(key, { ...old, ...attributes });
    const h = this.accessories.get(uuid)?.handlers?.fanControl;
    if (cluster === 'fanControl' && h) {
      if ('fanMode' in attributes && attributes.fanMode !== old.fanMode) {
        h.fanModeChange({ fanMode: attributes.fanMode, oldFanMode: old.fanMode });
      }
      if ('percentSetting' in attributes && attributes.percentSetting !== old.percentSetting) {
        h.percentSettingChange({ percentSetting: attributes.percentSetting, oldPercentSetting: old.percentSetting });
      }
    }
  }
  async getAccessoryState(uuid: string, cluster: string): Promise<Record<string, unknown> | undefined> {
    return this.state.get(`${uuid}|${cluster}`);
  }
  names(): string[] {
    return [...this.accessories.values()].map(a => a.displayName);
  }
  byName(name: string): MatterAccessoryLike {
    const a = [...this.accessories.values()].find(x => x.displayName === name);
    assert.ok(a, `Matter accessory ${name}`);
    return a;
  }
  get(name: string, cluster: string): Record<string, unknown> {
    return this.state.get(`${this.byName(name).UUID}|${cluster}`) ?? {};
  }
  /** Apple Home writing a fan attribute. */
  write(name: string, attrs: Record<string, unknown>): Promise<void> {
    return this.updateAccessoryState(this.byName(name).UUID, 'fanControl', attrs);
  }
  /** Apple Home sending an on/off command to a tile. */
  async command(name: string, on: boolean): Promise<void> {
    this.byName(name).handlers!.onOff[on ? 'on' : 'off']();
  }
}

const withMatter = (fake: FakeMatter, hapOn = true) => (api: API): void => {
  Object.assign(api, { matter: fake, isMatterEnabled: () => true, isHapEnabled: () => hapOn });
};

test('connection choice: Matter when the bridge has it, HomeKit otherwise, never both', () => {
  const warns: string[] = [];
  const w = (m: string): void => { warns.push(m); };
  assert.equal(chooseConnection(undefined, true, true, w), 'matter');
  assert.equal(chooseConnection('auto', false, true, w), 'homekit');
  assert.equal(chooseConnection('homekit', true, true, w), 'homekit');
  assert.equal(chooseConnection('matter', true, false, w), 'matter');
  assert.equal(warns.length, 0);
  assert.equal(chooseConnection('matter', false, true, w), 'homekit');
  assert.equal(chooseConnection('homekit', true, false, w), 'matter');
  assert.equal(warns.length, 2);
  assert.equal(chooseConnection('homekit', false, false, w), 'homekit');
});

test('Matter value conversions', () => {
  assert.deepEqual([0, 17, 33, 50, 67, 100].map(fanModeFor), [0, 1, 1, 2, 3, 3]);
  assert.equal(levelFromPercent(100), 254);
  assert.equal(levelFromPercent(1), 3);
  assert.equal(percentFromLevel(254), 100);
  assert.equal(percentFromLevel(1), 1);
  for (const p of [1, 25, 50, 75, 100]) {
    assert.equal(percentFromLevel(levelFromPercent(p)), p);
  }
});

test('Matter: a Devanti-style fan is a plain fan, with reverse, breeze and timers as separately named tiles', async () => {
  const fake = new FakeMatter();
  const r = await rig({}, b => { b.devices = { fan3: devantiFan() }; }, withMatter(fake));
  try {
    assert.equal(r.accessories.size, 0, 'no HomeKit accessories when Matter is used');
    const a = fake.byName('Office Fan');
    assert.equal(a.deviceType, 'Fan');
    assert.equal('parts' in a, false, 'the fan has no child parts, so Apple Home keeps the fan icon');
    assert.deepEqual(fake.names(), ['Office Fan', 'Office Fan Reverse', 'Office Fan Breeze',
      'Office Fan Off in 1h', 'Office Fan Off in 2h', 'Office Fan Off in 4h', 'Office Fan Off in 8h']);
    assert.ok(fake.names().slice(1).every(n => fake.byName(n).deviceType === 'OnOffOutlet'));
    assert.equal(new Set([...fake.accessories.keys()]).size, 7);
    assert.deepEqual(fake.get('Office Fan', 'fanControl'), { fanMode: 0, percentSetting: 0, percentCurrent: 0, fanModeSequence: 0 });
    assert.ok(r.logs.some(l => l.includes('published over Matter')));
  } finally {
    await r.stop();
  }
});

test('Matter: speed, on and off, reverse and timers reach the fan, and our own updates are not sent back as commands', async () => {
  const fake = new FakeMatter();
  const r = await rig({}, b => { b.devices = { fan3: devantiFan() }; }, withMatter(fake));
  try {
    // Apple Home sets 67 percent on a six speed fan: speed 4.
    await fake.write('Office Fan', { percentSetting: 67 });
    await wait(600);
    assert.deepEqual(r.bridge.log, ['SetSpeed 4']);
    assert.deepEqual(fake.get('Office Fan', 'fanControl'), { fanMode: 3, percentSetting: 67, percentCurrent: 67, fanModeSequence: 0 });
    // 40 percent is not a real step. The fan gets speed 2 and the slider snaps to 33.
    await fake.write('Office Fan', { percentSetting: 40 });
    await wait(600);
    assert.deepEqual(r.bridge.log, ['SetSpeed 4', 'SetSpeed 2']);
    assert.equal(fake.get('Office Fan', 'fanControl').percentSetting, 33);
    // Off by mode, then on again by mode: the last speed is used.
    await fake.write('Office Fan', { fanMode: 0 });
    await wait(600);
    assert.equal(r.bridge.log.at(-1), 'TurnOff');
    assert.equal(fake.get('Office Fan', 'fanControl').percentSetting, 0);
    await fake.write('Office Fan', { fanMode: 3 });
    await wait(600);
    assert.deepEqual(r.bridge.log.slice(-2), ['TurnOff', 'SetSpeed 2']);
    // Reverse, a timer, then cancel it.
    await fake.command('Office Fan Reverse', true);
    await wait(500);
    assert.equal(r.bridge.log.at(-1), 'ToggleDirection');
    await fake.command('Office Fan Off in 2h', true);
    await wait(500);
    assert.equal(r.bridge.log.at(-1), 'SetTimer 7200');
    assert.deepEqual(fake.get('Office Fan Off in 2h', 'onOff'), { onOff: true });
    assert.deepEqual(fake.get('Office Fan Reverse', 'onOff'), { onOff: true });
    await fake.command('Office Fan Off in 2h', false);
    await wait(500);
    assert.equal(r.bridge.log.at(-1), 'SetTimer 0');
    const count = r.bridge.log.length;

    // The Bond app changes the fan. Matter follows, and nothing is sent back to the fan.
    r.bridge.devices.fan3.state.speed = 6;
    r.bridge.pushState('fan3');
    await wait(300);
    assert.equal(fake.get('Office Fan', 'fanControl').percentSetting, 100);
    r.bridge.devices.fan3.state.power = 0;
    r.bridge.pushState('fan3');
    await wait(300);
    assert.equal(fake.get('Office Fan', 'fanControl').fanMode, 0);
    assert.equal(r.bridge.log.length, count, 'state coming from the bridge never becomes a command');
  } finally {
    await r.stop();
  }
});

test('Matter: lights become light endpoints with brightness', async () => {
  const fake = new FakeMatter();
  const r = await rig({}, b => { b.devices = { fan1: fullFan() }; }, withMatter(fake));
  try {
    const light = fake.byName('Lounge Fan Light');
    assert.equal(light.deviceType, 'DimmableLight');
    light.handlers!.levelControl.moveToLevelWithOnOff({ level: 203 });
    await wait(900);
    assert.deepEqual(r.bridge.log, ['TurnLightOn', 'SetBrightness 80']);
    assert.deepEqual(fake.get('Lounge Fan Light', 'levelControl'), { currentLevel: 203 });
    light.handlers!.onOff.off();
    await wait(500);
    assert.equal(r.bridge.log.at(-1), 'TurnLightOff');
  } finally {
    await r.stop();
  }
});

test('switching connection moves the devices across instead of showing them twice', async () => {
  // First run on HomeKit, with the HomeKit accessories remembered for the next run.
  const first = await rig({}, b => { b.devices = { fan3: devantiFan() }; });
  const remembered = [...first.accessories.values()];
  assert.equal(remembered.length, 1);
  await first.stop();

  const fake = new FakeMatter();
  const bridge = new FakeBridge();
  bridge.devices = { fan3: devantiFan() };
  await bridge.start();
  const api = new HomebridgeAPI() as API;
  withMatter(fake)(api);
  const gone: string[] = [];
  api.on('unregisterPlatformAccessories' as never, ((list: PlatformAccessory[]) => list.forEach(a => gone.push(a.displayName))) as never);
  const logs: string[] = [];
  const logFn = (m: string): void => { logs.push(m); };
  const log = Object.assign(logFn, { info: logFn, warn: logFn, error: logFn, debug: () => undefined });
  const platform = new Bond5m5Platform(log as never, { platform: 'Bond5m5', bridges: [{ host: bridge.host, token: bridge.token }], bpupPort: bridge.udpPort } as never, api);
  remembered.forEach(a => platform.configureAccessory(a));
  platform.configureMatterAccessory({ UUID: 'old-matter', displayName: 'Removed Fan', context: { bondId: 'ZZTEST12345', deviceId: 'gone' } });
  (api as unknown as { emit(e: string): void }).emit('didFinishLaunching');
  await wait(600);
  (api as unknown as { emit(e: string): void }).emit('shutdown');
  await bridge.stop();
  assert.deepEqual(gone, ['Office Fan'], 'the HomeKit copy is removed');
  assert.ok(logs.some(l => l.includes('Removed 1 device(s) from HomeKit')));
  assert.equal(fake.byName('Office Fan').deviceType, 'Fan');
  assert.deepEqual(fake.unregistered, ['Removed Fan'], 'a remembered Matter device that no longer exists is removed');
  assert.equal(fake.names().length, 7);
});

test('Matter: turning the timer switches off in the settings removes those tiles and keeps the rest', async () => {
  const fake = new FakeMatter();
  const r = await rig({ timerSwitches: false }, b => { b.devices = { fan3: devantiFan() }; }, api => {
    withMatter(fake)(api);
  });
  try {
    assert.deepEqual(fake.names(), ['Office Fan', 'Office Fan Reverse', 'Office Fan Breeze']);
  } finally {
    await r.stop();
  }
});

test('Matter speed steps: the fan declares six speeds, shows the speed number, and a speed set by number reaches the fan', async () => {
  const fake = new FakeMatter();
  // A fan type that can be composed with features, like the real Matter library's.
  const stepped = { name: 'FanWithMultiSpeed' };
  (fake.deviceTypes as Record<string, unknown>).Fan = { with: () => stepped, behaviors: { fanControl: { with: (f: string) => `fanControl+${f}` } } };
  const r = await rig({}, b => { b.devices = { fan3: devantiFan() }; }, withMatter(fake));
  try {
    const a = fake.byName('Office Fan');
    assert.equal(a.deviceType, stepped);
    assert.deepEqual(fake.get('Office Fan', 'fanControl'),
      { fanMode: 0, percentSetting: 0, percentCurrent: 0, speedSetting: 0, speedCurrent: 0, fanModeSequence: 0, speedMax: 6 });
    // By percentage, as before.
    await fake.write('Office Fan', { percentSetting: 50 });
    await wait(600);
    assert.deepEqual(r.bridge.log, ['SetSpeed 3']);
    assert.equal(fake.get('Office Fan', 'fanControl').speedSetting, 3);
    // By speed number, which Homebridge does not report to the plugin. The plugin notices by checking.
    await fake.write('Office Fan', { speedSetting: 5 });
    await wait(1900);
    assert.deepEqual(r.bridge.log, ['SetSpeed 3', 'SetSpeed 5']);
    assert.equal(fake.get('Office Fan', 'fanControl').percentSetting, 83);
    await fake.write('Office Fan', { speedSetting: 0 });
    await wait(1900);
    assert.equal(r.bridge.log.at(-1), 'TurnOff');
    const count = r.bridge.log.length;
    // A change from the Bond side is shown and never sent back.
    r.bridge.devices.fan3.state.power = 1;
    r.bridge.devices.fan3.state.speed = 2;
    r.bridge.pushState('fan3');
    await wait(2200);
    assert.equal(fake.get('Office Fan', 'fanControl').speedSetting, 2);
    assert.equal(r.bridge.log.length, count);
  } finally {
    await r.stop();
  }
});

test('Matter speed steps can be switched off, and are skipped when Homebridge cannot compose them', async () => {
  assert.equal(multiSpeedFan('Fan'), undefined);
  assert.equal(multiSpeedFan({ with: () => { throw new Error('no'); }, behaviors: { fanControl: { with: () => 1 } } }), undefined);
  const fake = new FakeMatter();
  const plain = { with: () => ({ name: 'stepped' }), behaviors: { fanControl: { with: () => 1 } } };
  (fake.deviceTypes as Record<string, unknown>).Fan = plain;
  const r = await rig({ matterSpeedSteps: false }, b => { b.devices = { fan3: devantiFan() }; }, withMatter(fake));
  try {
    assert.equal(fake.byName('Office Fan').deviceType, plain);
    assert.equal('speedMax' in fake.get('Office Fan', 'fanControl'), false);
  } finally {
    await r.stop();
  }
});
