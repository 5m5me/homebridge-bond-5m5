import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeDevice, mapCapabilities } from '../src/capabilities';
import { fanPatch, lightIsOn, lightPatch, percentToSpeed, planFan, planLight, speedToPercent } from '../src/logic';
import { BondDevice } from '../src/types';
import { fullFan, toggleFan } from './fakeBridge';

const dev = (d: ReturnType<typeof fullFan>): BondDevice => ({ id: 'abc', ...d });
const names = (a: Array<{ name: string; argument?: number }>): string[] => a.map(x => (x.argument === undefined ? x.name : `${x.name} ${x.argument}`));

test('speed and percent convert both ways for every speed', () => {
  for (const max of [1, 3, 4, 6, 8]) {
    for (let s = 1; s <= max; s++) {
      assert.equal(percentToSpeed(speedToPercent(s, max), max), s);
    }
  }
  assert.equal(percentToSpeed(0, 6), 0);
  assert.equal(percentToSpeed(1, 6), 1);
  assert.equal(percentToSpeed(100, 3), 3);
  assert.equal(speedToPercent(0, 3), 0);
  assert.equal(speedToPercent(9, 3), 100);
});

test('full fan capabilities', () => {
  const caps = mapCapabilities(dev(fullFan()));
  assert.equal(caps.kind, 'fan');
  assert.deepEqual(caps.fan, { power: 'direct', speed: true, maxSpeed: 6, maxSpeedAssumed: false, direction: 'set' });
  assert.deepEqual(caps.light, { kind: 'single', power: 'direct', brightness: true, upDownBrightness: false, dimmer: false });
  assert.deepEqual(caps.unused, ['TogglePower', 'IncreaseSpeed', 'DecreaseSpeed', 'ToggleDirection', 'ToggleLight', 'SetTimer']);
});

test('toggle-only fan capabilities, hold-to-dim light', () => {
  const caps = mapCapabilities(dev(toggleFan()));
  assert.equal(caps.fan?.power, 'toggle');
  assert.equal(caps.fan?.direction, 'toggle');
  assert.equal(caps.light?.power, 'toggle');
  assert.equal(caps.light?.brightness, false);
  assert.equal(caps.light?.dimmer, true);
});

test('missing max_speed is assumed and flagged', () => {
  const d = dev(fullFan());
  d.properties = {};
  const caps = mapCapabilities(d);
  assert.equal(caps.fan?.maxSpeed, 3);
  assert.equal(caps.fan?.maxSpeedAssumed, true);
  assert.ok(describeDevice(d, caps).some(l => l.includes('assumed')));
});

test('features switched off in the Bond app are respected', () => {
  const d = dev(fullFan());
  d.properties.feature_light = false;
  assert.equal(mapCapabilities(d).light, undefined);
  d.properties = { max_speed: 6, feature_brightness: false };
  assert.equal(mapCapabilities(d).light?.brightness, false);
});

test('up and down lights, plain light device, unsupported types', () => {
  const d = dev(fullFan());
  d.actions = ['TurnOn', 'TurnOff', 'TurnLightOn', 'TurnLightOff', 'TurnUpLightOn', 'TurnUpLightOff', 'TurnDownLightOn', 'TurnDownLightOff'];
  assert.equal(mapCapabilities(d).light?.kind, 'updown');
  const lt = dev({ name: 'Lamp', type: 'LT', actions: ['TurnLightOn', 'TurnLightOff'], properties: {}, state: {} });
  assert.equal(mapCapabilities(lt).kind, 'light');
  const bare = dev({ name: 'Odd', type: 'LT', actions: ['TurnOn'], properties: {}, state: {} });
  assert.equal(mapCapabilities(bare).kind, 'unsupported');
  const fp = dev({ name: 'Fire', type: 'FP', actions: ['TurnOn', 'TurnOff'], properties: {}, state: {} });
  const caps = mapCapabilities(fp);
  assert.equal(caps.kind, 'unsupported');
  assert.ok(describeDevice(fp, caps).some(l => l.includes('Not shown')));
});

test('fan plans, direct control', () => {
  const caps = mapCapabilities(dev(fullFan())).fan!;
  const off = { power: 0, speed: 2, direction: 1 };
  const on = { power: 1, speed: 2, direction: 1 };
  assert.deepEqual(names(planFan({ active: true }, off, caps)), ['TurnOn']);
  assert.deepEqual(names(planFan({ active: true }, on, caps)), []);
  assert.deepEqual(names(planFan({ active: true, speed: 2 }, off, caps)), ['SetSpeed 2']);
  assert.deepEqual(names(planFan({ active: true, speed: 2 }, on, caps)), []);
  assert.deepEqual(names(planFan({ speed: 5 }, on, caps)), ['SetSpeed 5']);
  assert.deepEqual(names(planFan({ active: false, speed: 5 }, on, caps)), ['TurnOff']);
  assert.deepEqual(names(planFan({ speed: 0 }, on, caps)), ['TurnOff']);
  assert.deepEqual(names(planFan({ direction: -1 }, on, caps)), ['SetDirection -1']);
  assert.deepEqual(names(planFan({ direction: 1 }, on, caps)), []);
});

test('fan plans, toggle-only control never toggles when already right', () => {
  const caps = mapCapabilities(dev(toggleFan())).fan!;
  const off = { power: 0, speed: 1, direction: 1 };
  const on = { power: 1, speed: 1, direction: 1 };
  assert.deepEqual(names(planFan({ active: true }, off, caps)), ['TogglePower']);
  assert.deepEqual(names(planFan({ active: true }, on, caps)), []);
  assert.deepEqual(names(planFan({ active: false }, on, caps)), ['TogglePower']);
  assert.deepEqual(names(planFan({ active: false }, off, caps)), []);
  assert.deepEqual(names(planFan({ active: true, speed: 1 }, off, caps)), ['TogglePower']);
  assert.deepEqual(names(planFan({ active: true, speed: 3 }, off, caps)), ['TogglePower', 'SetSpeed 3']);
  assert.deepEqual(names(planFan({ direction: -1 }, on, caps)), ['ToggleDirection']);
});

test('fan state corrections', () => {
  const caps = mapCapabilities(dev(fullFan())).fan!;
  assert.deepEqual(fanPatch({ active: false }, caps), { power: 0 });
  assert.deepEqual(fanPatch({ active: true, speed: 4 }, caps), { power: 1, speed: 4 });
  assert.deepEqual(fanPatch({ direction: -1 }, caps), { direction: -1 });
});

test('light plans', () => {
  const full = mapCapabilities(dev(fullFan())).light!;
  assert.deepEqual(names(planLight('light', { on: true }, { light: 0 }, full)), ['TurnLightOn']);
  assert.deepEqual(names(planLight('light', { on: true }, { light: 1 }, full)), []);
  assert.deepEqual(names(planLight('light', { on: true, brightness: 80 }, { light: 0, brightness: 50 }, full)), ['TurnLightOn', 'SetBrightness 80']);
  assert.deepEqual(names(planLight('light', { brightness: 50 }, { light: 1, brightness: 50 }, full)), []);
  assert.deepEqual(names(planLight('light', { brightness: 0 }, { light: 1 }, full)), ['TurnLightOff']);
  assert.deepEqual(names(planLight('light', { on: false }, { light: 0 }, full)), ['TurnLightOff']);
  const tog = mapCapabilities(dev(toggleFan())).light!;
  assert.deepEqual(names(planLight('light', { on: true }, { light: 0 }, tog)), ['ToggleLight']);
  assert.deepEqual(names(planLight('light', { on: true }, { light: 1 }, tog)), []);
  assert.deepEqual(names(planLight('light', { on: false }, { light: 0 }, tog)), []);
  assert.deepEqual(names(planLight('light', { on: true, brightness: 40 }, { light: 1 }, tog)), []);
});

test('up and down light plans and state', () => {
  const d = dev(fullFan());
  d.actions = ['TurnLightOn', 'TurnLightOff', 'TurnUpLightOn', 'TurnUpLightOff', 'TurnDownLightOn', 'TurnDownLightOff'];
  const caps = mapCapabilities(d).light!;
  assert.equal(lightIsOn('up', { light: 1, up_light: 1, down_light: 0 }), true);
  assert.equal(lightIsOn('down', { light: 1, up_light: 1, down_light: 0 }), false);
  assert.equal(lightIsOn('up', { light: 0, up_light: 1 }), false);
  assert.deepEqual(names(planLight('up', { on: true }, { light: 0, up_light: 1 }, caps)), ['TurnUpLightOn']);
  assert.deepEqual(names(planLight('down', { on: false }, { light: 1, down_light: 1 }, caps)), ['TurnDownLightOff']);
  assert.deepEqual(lightPatch('up', { on: true }, caps), { up_light: 1, light: 1 });
  assert.deepEqual(lightPatch('light', { on: false }, caps), { light: 0 });
});
