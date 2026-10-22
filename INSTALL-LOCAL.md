# Installing the local-first build (Docker Homebridge)

This fork keeps the plugin name `@0x5e/homebridge-tuya-platform`, so HomeKit accessories, rooms and
automations stay as they are. It adds LAN control (see [DESIGN-LOCAL.md](./DESIGN-LOCAL.md)).

## Install

1. Download `0x5e-homebridge-tuya-platform-<version>.tgz` from the
   [Releases](https://github.com/PiotrekGMO/homebridge-tuya-platform/releases) page and put it in the Homebridge
   data folder (`/homebridge`, the volume of the container).
2. In `/homebridge/package.json` point the plugin at that file, so every container start installs exactly it:

   ```json
   "dependencies": {
     "@0x5e/homebridge-tuya-platform": "file:0x5e-homebridge-tuya-platform-<version>.tgz"
   }
   ```

3. Install it **while Homebridge is stopped or idle, and never restart Homebridge until `npm install` is finished**
   (a half-installed plugin does not load, and Homebridge then removes its accessories):

   ```bash
   cd /homebridge && npm install --omit=dev --no-save --legacy-peer-deps --no-audit --no-fund ./0x5e-homebridge-tuya-platform-<version>.tgz
   ```

4. Restart Homebridge from the UI.

## Protect the accessories

In the Homebridge UI, Settings, switch on **Keep Accessories Of Uninstalled Plugins** (the `-K` / `--keep-orphans`
flag). If the plugin ever fails to load, Home keeps its accessories instead of deleting them. Also enable the
scheduled backups there.

## Configuration

Add `local` next to the usual options (nothing else changes):

```json
"options": {
  "projectType": "2",
  "accessId": "...", "accessKey": "...", "countryCode": 48,
  "username": "...", "password": "...", "appSchema": "tuyaSmart",
  "local": { "enabled": true }
}
```

- Devices are found by themselves, addresses can change (DHCP). The plugin remembers them in
  `persist/TuyaLocalSnapshot.json` and looks a device up again when its address stops answering.
- `local.exclude`: device ids or product ids that stay cloud-only.
- `localDevices`: add or complete devices by hand (see the README), an `ip` given there is never forgotten.
- Without the Tuya cloud (expired trial) set `"projectType": "3"`: devices come from the snapshot that was
  written during the last cloud sync.

## What the build adds

- LAN control with the cloud as a fallback, and a local snapshot (keys, data point ids).
- Devices the cloud calls unsupported (thing model), e.g. thermometers with a DP-only product.
- RF remotes on IR+RF hubs (blinds): found through the hub, sent over LAN with `"ver": "2"`.
- Lamps with a motion sensor (auto / manual mode switch, manual brightness remembered).
- Automatic login again when the cloud token is invalidated (another session on the same account).

## Update

Put the new `.tgz` next to `package.json`, change the file name in `package.json`, run the install command from
step 3 while Homebridge is idle, restart from the UI. Keep the previous `.tgz`, so going back is the same steps.
