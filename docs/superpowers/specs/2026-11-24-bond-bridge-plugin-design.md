# Bond Bridge Homebridge plugin: design

Date: 24 November 2026. Status: version 1.2.0. Versions 1.0.0 and 1.1.0 were run against the real bridge on 24 November 2026: it connected, reported three fans, and picked up a fan added in the Bond app without a restart. Commands from Apple Home to a real fan have not been tested yet.

## Goal

Ned's own Homebridge plugin for his Bond Bridge (standard model, radio and infrared), fully under his control, so the bridge's devices work in Apple Home as fully as the bridge allows. Two ceiling fans now, six more planned. The fans are Devanti: six speeds, stop, reverse, timers (1H, 2H, 4H, 8H) and a three-lines button. No lights on any of them. Infrared lights are a possible later addition.

## Decisions (Ned's)

- Clean build, not a fork of homebridge-bond.
- Own package name, own GitHub repository, not on npm. Frozen release branches, as with the Gree plugin.
- Local network only. No Bond cloud.
- Breeze and the four sleep timers are built in as switches (Ned's decision, 24 November 2026).
- Matter support added so either connection can be chosen (Ned's decision, 24 November 2026). On his server the HomeKit pairing would not connect and the Matter pairing did.

## Packaging

- Package `homebridge-bond-5m5`, display name "Bond (5m5)", platform name `Bond5m5`.
- TypeScript, no runtime dependencies.
- Works on Homebridge 1.8 or later and 2.x (checked on 1.11.4 and 2.5.0).

## Parts

| File | Job |
|---|---|
| `bondClient.ts` | Talks to the bridge over HTTP. Commands go one at a time with a 300 ms gap. Reads and safe commands are retried twice. Toggle, increase, decrease, cycle and start commands are never resent, because sending them twice changes the result. |
| `bpup.ts` | Listens for the bridge's push updates on UDP 30007. Renews the subscription every 60 seconds. |
| `capabilities.ts` | Turns the bridge's list of actions for a device into what to show in Apple Home. Nothing is tied to a fan model. Also writes the startup report. |
| `logic.ts` | Works out which commands to send for a change in Apple Home, given what the bridge believes now. Pure logic. |
| `deviceCore.ts` | One device: what it can do, what the bridge believes, and how to command it. Knows nothing about HomeKit or Matter. |
| `hapPublisher.ts` | Shows devices over HomeKit. |
| `matterPublisher.ts` | Shows devices over Matter, through Homebridge 2's Matter bridge. |
| `bridge.ts` | One bridge: connect, device list, state checks, online or offline, finding the bridge again. |
| `locator.ts` | Finds a bridge by Bond ID: the address in the settings, `<bondid>.local`, then every address on the last known /24 network. Private networks only. |
| `store.ts` | Remembers each bridge's Bond ID and last working address in `bond-5m5-bridges.json` in the Homebridge storage folder. Written only on change. |
| `platform.ts` | Reads the settings and starts one session per bridge. |

## Behaviour

- Connection (1.2.0): the `connection` setting is Automatic, Matter or HomeKit. Automatic uses Matter when the bridge has Matter switched on, otherwise HomeKit. Devices go over one connection only. On start, anything remembered on the other connection is removed so nothing shows twice.
- Over Matter, a fan is a Fan device (mode and percentage). Homebridge's Matter fan support has no direction control, so Reverse is a separate on/off tile, as are Breeze, the timers and Correct State. Lights are light endpoints, with brightness where the bridge can set a level.
- Matter reports the plugin's own state updates back as if they were commands. Any command that matches what the plugin already believes is ignored, so a change made in the Bond app is never sent back to the fan.
- Fans (type CF): Active, speed in steps of 100 / max_speed, direction (forward = counter-clockwise in Apple Home). If the bridge does not report max_speed, 3 is assumed and the report says so.
- Breeze (1.1.0): a switch per fan when the bridge offers BreezeOn and BreezeOff. Shown off whenever the fan is off.
- Sleep timers (1.1.0): four switches per fan (Off in 1h, 2h, 4h, 8h) when the bridge offers SetTimer. On sends the time in seconds, off sends 0. Only one shows as on. The bridge reports only the time left, so after a Homebridge restart the smallest option that covers the time left is shown.
- Remotes with an off button but no on button (1.1.0): a speed command turns the fan on, using the last speed or speed 1.
- Both sets of switches can be turned off in the settings.
- Lights: one light, or separate up and down lights. A brightness slider only where the bridge has SetBrightness. Hold-to-dim remotes (StartDimmer and Stop) get a Dimmer switch that stops itself after 15 seconds.
- Toggle-only remotes: a toggle is sent only when the tile and the bridge's belief differ.
- Apple Home sends power and speed as separate writes. They are collected for 80 ms and sent as one plan.
- Features switched off for a device in the Bond app (feature_light, feature_brightness, feature_up_down_light) are not shown.
- Correct State (off by default): a switch per device. While on, for 30 seconds, changes are written to the bridge's belief (PATCH state) and no signal is sent.
- State: push updates, plus a check every 30 seconds (setting: 5 to 600).
- Device list is re-read every 5 minutes. New devices are added, changed ones rebuilt, deleted ones removed.
- Bridge not answering: tiles show No Response. After 90 seconds offline the plugin searches for the bridge, at most once every 5 minutes.
- Wrong token: one clear line in the log.
- Device types other than CF and LT are listed in the report and not shown.

## Testing

- 40 automated tests. They cover the mapping and command logic, the HTTP client, push parsing and a live push, the address search, the store, the settings, and the whole plugin running on real Homebridge code against a simulated bridge (tiles created, commands sent, push followed, Correct State, No Response, hidden and unsupported devices, wrong token, a Devanti-style fan with breeze and timers, the same fan over a stand-in Matter interface, and moving devices from one connection to the other).
- Matter was also run inside real Homebridge 2.5.0 with its real Matter server: both test fans registered with all their parts, state changes went through, and no command was sent back to the fans. The test machine has no IPv6, so a small shim was needed to start the Matter server there.
- The built plugin was also started inside real Homebridge 1.11.4 and 2.5.0 processes against the simulated bridge.

Not tested:

- Commands from Apple Home to a real fan (on, off, each speed, direction, timers).
- Matter with a real controller. Nothing in the tests pairs with Apple Home, so how the Home app writes fan mode and percentage, and how it shows the extra on/off tiles, is unproven until tried on the real system.
- Why the HomeKit pairing would not connect on Ned's server. Not investigated.
- Up and down lights against a real device (logic tests only).
- Breeze on real hardware. The real bridge offers a timer (SetTimer) for the Devanti fans but no breeze action, so no Breeze switch appears. The three-lines button would have to be added in the Bond app first.
- Whether the bridge's timer needs the fan to be running first, and whether breeze turns the fan on. The plugin sends the command either way.
- The address search on a real network.
- The Bond ID field (`bondid`) is confirmed on the real bridge (firmware v4.40.1).

## Limits

- Fan and light state is what the bridge believes. A wall remote can put it out of step. Correct State is the fix.
- The address search sends about 250 small requests in a few seconds. On a router with intrusion detection this can look like a scan.
- The token is stored in plain text in the Homebridge config, as for other plugins.
- Timers and breeze have no Apple Home equivalent, so they are plain switches. With all eight fans that is up to 40 extra switches.
- Over Matter the extra tiles are outlets as far as Apple Home is concerned. Each can be shown as a switch or fan in the Home app's settings for that tile.
- Over Matter, a tile does not show No Response when the Bond Bridge is unreachable. The log says so instead.
- Breeze and timer switches always send their command, also while Correct State is on.

## Release 2 (not built)

- Per-device override in the settings: treat a Bond device as a light and map its recorded buttons to on, off, brighter, dimmer and extra switches. This is the infrared light work and needs a real remote to design against.
- Blinds, fireplaces and generic devices.
