# homebridge-bond-5m5

Homebridge plugin for the Bond Bridge, using the bridge's local API. A clean build, not a fork, and not published to npm, so Homebridge never offers an update for it.

Shown in Homebridge as "Bond (5m5)". Platform name: `Bond5m5`.

## What it does (version 1.2.0)

- Works over Matter or HomeKit (Homebridge 2 for Matter). One setting chooses. Devices are never published over both, so nothing shows twice.
- Ceiling fans: on and off, speed (the slider snaps to the fan's real speeds), direction where the remote has it.
- Breeze (natural wind) switch on fans whose remote has it.
- Sleep timer switches on fans that have a timer: Off in 1h, 2h, 4h, 8h. Turning one on replaces any other. Turning it off cancels the timer.
- Remotes with no on button: a speed turns the fan on (the last speed used, or speed 1).
- Fan lights and stand-alone lights: on and off, brightness where the bridge can set a level, separate up and down lights.
- Lights that only dim by holding the button get a "Dimmer" switch: on starts dimming, off stops it. It stops by itself after 15 seconds.
- Optional "Correct State" switch per device: for 30 seconds, changes in Apple Home fix what the tile shows and send nothing to the device.
- Instant updates from the bridge (BPUP push), plus a background check every 30 seconds.
- Devices added, changed or deleted in the Bond app are picked up within 5 minutes. No restart.
- If the bridge's IP address changes, the plugin finds it again by its Bond ID.
- A report in the log at start lists every device and every action the bridge offers for it.

Over Matter, a fan is a fan tile (on, off, speed) with its extras as separate on/off tiles: Reverse, Breeze, the timers, Correct State. Over HomeKit, direction is part of the fan tile.

Not in this version: blinds, fireplaces, generic devices, infrared light button mapping.

## Install

In the Homebridge terminal, in /var/lib/homebridge:

    npm install --save --omit=dev https://github.com/5m5me/homebridge-bond-5m5/archive/refs/heads/release-1.2.0.tar.gz

Restart Homebridge fully (a new plugin name is only recognised after a full restart). Then open the plugin settings and add the bridge's IP address and local token.

## Development

    npm install
    npm test        # 40 tests, including the plugin running on real Homebridge code against a simulated bridge
    npm run build

`main` holds source only. Each release has its own branch (`release-x.y.z`) with the compiled code added, and is not changed afterwards.

Design document: docs/superpowers/specs/2026-11-24-bond-bridge-plugin-design.md
