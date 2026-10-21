# Local-first mode (fork design)

## Goals
1. Control Tuya devices over LAN (TCP 6668) and keep working after the Tuya IoT cloud trial expires.
2. Add devices the cloud does not support (e.g. empty specification, code 2009) by configuration only.
3. Keep the same HomeKit accessories (UUID = hash of device id, unchanged).

## Architecture
Accessories talk to `TuyaDeviceManager` using *codes* (`switch_1`, `bright_value_v2`, ...) and receive
`DEVICE_STATUS_UPDATE(device, [{code,value}])`. The seam is therefore the manager:

- `sendCommands(deviceID, [{code,value}])` -> local first (code -> `dp_id` via schema), cloud as fallback.
- Local status pushes (`dps`) -> `dp_id` -> code -> same `DEVICE_STATUS_UPDATE` event.
- The accessory layer is untouched.

### Components
| File | Role |
|---|---|
| `src/core/TuyaLocal.ts` | One persistent `tuyapi` connection per device: connect, heartbeat, reconnect with backoff, `get`/`set` by DP id, emits `data` (dps). Pure transport, no HomeKit knowledge. |
| `src/device/TuyaLocalSnapshot.ts` | Read/write `persist/TuyaLocalSnapshot.json`: per device `id, name, category, product_id, local_key, ip, version, schema[+dp_id], status`. |
| `src/device/TuyaLocalDeviceManager.ts` | Manager that works without cloud: devices come from snapshot and/or `localDevices` in config; commands and status are local only. |
| `src/device/TuyaDeviceManager.ts` | Gets an optional `local` layer: when a device is local-capable and connected, commands go over LAN. |
| `src/platform.ts` | Login fails or `projectType: '3'` -> start from snapshot. After a successful cloud sync the snapshot is refreshed. |

### Snapshot (cloud independence)
- Written after every successful cloud sync, merged by device id (never drops a device because of one failed sync).
- Needs `dp_id` for every schema entry. `/v1.0/devices/{id}/specifications` returns it, today it is dropped in
  `getDeviceSchema`; keep it (`TuyaDeviceSchema.dp_id?`).
- `local_key` changes only when a device is re-paired, so a snapshot stays valid for years.
- The snapshot holds secrets: stored in Homebridge `persist`, never logged.

### Config additions
```jsonc
"options": {
  "projectType": "3",                // cloud-less mode, or keep "2" and snapshot is used as fallback
  "local": { "enabled": true, "preferLocal": true, "heartbeat": 10, "scan": true },
  "localDevices": [                  // add ANY device by configuration, no code change
    {
      "id": "bf...", "name": "Termometr", "key": "xxxxxxxxxxxxxxxx",
      "ip": "192.168.1.50", "version": "3.3",
      "category": "wsdcg",
      "schema": [
        { "code": "va_temperature", "dp_id": 1, "type": "Integer", "mode": "ro", "property": {"min":-400,"max":1000,"scale":1,"step":1,"unit":"C"} },
        { "code": "va_humidity",    "dp_id": 2, "type": "Integer", "mode": "ro", "property": {"min":0,"max":100,"scale":0,"step":1,"unit":"%"} }
      ]
    }
  ]
}
```
`localDevices` entries override the snapshot for the same id. Existing `deviceOverrides` (category, code
remapping, onGet/onSet) keep working on top of them, so unsupported devices are handled by config.

## Behaviour
- Start: cloud login attempted; on failure (or `projectType: '3'`) load snapshot + `localDevices`.
- IP: from config, else from last known, else UDP discovery (6666/6667) when the network allows it.
- Online state: derived from the local connection when cloud is absent.
- Reconnect: exponential backoff 2 s .. 60 s; Tuya devices accept one connection at a time, so only the plugin
  should hold it (the Tuya app on the same LAN still works through the cloud).
- Sub-devices, IR hubs, scenes, cameras: cloud only (unchanged), skipped in local mode.

## Verified on this LAN (tuyapi 7.7.1, Node 24)
cz 3.3 (4x), gyd 3.3 (3x), dd 3.3, kg 3.4. No 3.5 devices found. Battery devices do not listen on 6668.

## Phases
1. `TuyaLocal` transport + unit tests with a fake tuyapi.
2. Snapshot with `dp_id` + manager integration, local commands with cloud fallback.
3. Cloud-less start (`projectType: '3'`, `localDevices`) + schema (`config.schema.json`) UI.
4. Test in Docker against real devices (read first, then one write with user approval), then Homebridge on NAS.
