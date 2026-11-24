import { FanCaps, LightCaps } from './capabilities';
import { BondAction, BondState } from './types';

export function speedToPercent(speed: number, max: number): number {
  if (!(speed > 0)) {
    return 0;
  }
  return Math.min(100, Math.round((Math.min(speed, max) / max) * 10000) / 100);
}

export function percentToSpeed(percent: number, max: number): number {
  if (!(percent > 0)) {
    return 0;
  }
  return Math.max(1, Math.min(max, Math.round((percent / 100) * max)));
}

export interface FanWish {
  active?: boolean;
  speed?: number; // Bond speed, 1..max. 0 means off.
  direction?: 1 | -1;
}

const isOn = (v: unknown): boolean => v === 1 || v === true;

/** Commands to send so the fan matches the wish, given what the bridge believes now. */
export function planFan(wish: FanWish, state: BondState, caps: FanCaps): BondAction[] {
  const out: BondAction[] = [];
  const on = isOn(state.power);
  const wantOff = wish.active === false || wish.speed === 0;
  if (wantOff) {
    if (caps.power === 'direct' || caps.power === 'offOnly') {
      out.push({ name: 'TurnOff' });
    } else if (caps.power === 'toggle' && on) {
      out.push({ name: 'TogglePower' });
    }
    return out;
  }
  const wantSpeed = caps.speed && wish.speed !== undefined && wish.speed > 0;
  if (wantSpeed) {
    if (caps.power === 'toggle' && !on) {
      out.push({ name: 'TogglePower' });
    }
    if ((!on && caps.power !== 'toggle') || Number(state.speed) !== wish.speed) {
      out.push({ name: 'SetSpeed', argument: wish.speed });
    }
  } else if (wish.active === true && !on) {
    if (caps.power === 'direct') {
      out.push({ name: 'TurnOn' });
    } else if (caps.power === 'toggle') {
      out.push({ name: 'TogglePower' });
    } else if (caps.speed) {
      // No on button on this remote. Pressing a speed is what turns the fan on.
      const last = Number(state.speed);
      out.push({ name: 'SetSpeed', argument: last >= 1 && last <= caps.maxSpeed ? last : 1 });
    }
  }
  if (wish.direction !== undefined && Number(state.direction) !== wish.direction) {
    if (caps.direction === 'set') {
      out.push({ name: 'SetDirection', argument: wish.direction });
    } else if (caps.direction === 'toggle') {
      out.push({ name: 'ToggleDirection' });
    }
  }
  return out;
}

/** State belief to write (no radio signal) for the same wish. Used by "Correct state". */
export function fanPatch(wish: FanWish, caps: FanCaps): BondState {
  const patch: BondState = {};
  if (wish.active === false || wish.speed === 0) {
    patch.power = 0;
  } else {
    if (wish.active === true || (wish.speed !== undefined && wish.speed > 0)) {
      patch.power = 1;
    }
    if (caps.speed && wish.speed !== undefined && wish.speed > 0) {
      patch.speed = wish.speed;
    }
  }
  if (wish.direction !== undefined && caps.direction !== 'none') {
    patch.direction = wish.direction;
  }
  return patch;
}

export type LightPart = 'light' | 'up' | 'down';

export interface LightWish {
  on?: boolean;
  brightness?: number; // 1..100. 0 means off.
}

const PART = {
  light: { on: 'TurnLightOn', off: 'TurnLightOff', set: 'SetBrightness', flag: 'light', level: 'brightness' },
  up: { on: 'TurnUpLightOn', off: 'TurnUpLightOff', set: 'SetUpLightBrightness', flag: 'up_light', level: 'up_light_brightness' },
  down: { on: 'TurnDownLightOn', off: 'TurnDownLightOff', set: 'SetDownLightBrightness', flag: 'down_light', level: 'down_light_brightness' },
} as const;

export function lightIsOn(part: LightPart, state: BondState): boolean {
  if (part === 'light') {
    return isOn(state.light);
  }
  return isOn(state.light) && isOn(state[PART[part].flag]);
}

export function lightLevel(part: LightPart, state: BondState): number | undefined {
  const v = Number(state[PART[part].level]);
  return v >= 1 && v <= 100 ? Math.round(v) : undefined;
}

export function planLight(part: LightPart, wish: LightWish, state: BondState, caps: LightCaps): BondAction[] {
  const out: BondAction[] = [];
  const p = PART[part];
  const on = lightIsOn(part, state);
  const canSet = part === 'light' ? caps.brightness : caps.upDownBrightness;
  if (wish.on === false || wish.brightness === 0) {
    if (part !== 'light' || caps.power === 'direct') {
      out.push({ name: p.off });
    } else if (caps.power === 'toggle' && on) {
      out.push({ name: 'ToggleLight' });
    }
    return out;
  }
  const wantLevel = canSet && wish.brightness !== undefined && wish.brightness > 0;
  if ((wish.on === true || wantLevel) && !on) {
    if (part !== 'light' || caps.power === 'direct') {
      out.push({ name: p.on });
    } else if (caps.power === 'toggle') {
      out.push({ name: 'ToggleLight' });
    }
  }
  if (wantLevel && lightLevel(part, state) !== wish.brightness) {
    out.push({ name: p.set, argument: wish.brightness });
  }
  return out;
}

export function lightPatch(part: LightPart, wish: LightWish, caps: LightCaps): BondState {
  const p = PART[part];
  const patch: BondState = {};
  const canSet = part === 'light' ? caps.brightness : caps.upDownBrightness;
  if (wish.on === false || wish.brightness === 0) {
    patch[p.flag] = 0;
    return patch;
  }
  if (wish.on === true || (wish.brightness !== undefined && wish.brightness > 0)) {
    patch[p.flag] = 1;
    if (part !== 'light') {
      patch.light = 1;
    }
  }
  if (canSet && wish.brightness !== undefined && wish.brightness > 0) {
    patch[p.level] = wish.brightness;
  }
  return patch;
}

export function breezeIsOn(state: BondState): boolean {
  const b = state.breeze;
  return Array.isArray(b) ? Number(b[0]) === 1 : b === 1 || b === true;
}

/**
 * Which timer switch to show as on. The bridge only reports seconds remaining,
 * so the switch last pressed wins. After a restart, the smallest option that still covers the time left is used.
 */
export function activeTimerHours(state: BondState, lastSetHours: number | undefined, options: number[]): number | undefined {
  const left = Number(state.timer);
  if (!(left > 0) || !isOn(state.power)) {
    return undefined;
  }
  if (lastSetHours !== undefined && options.includes(lastSetHours) && left <= lastSetHours * 3600) {
    return lastSetHours;
  }
  const sorted = [...options].sort((a, b) => a - b);
  return sorted.find(h => left <= h * 3600) ?? sorted[sorted.length - 1];
}
