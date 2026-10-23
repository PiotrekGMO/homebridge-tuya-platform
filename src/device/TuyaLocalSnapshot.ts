import fs from 'fs';
import path from 'path';
import TuyaDevice from './TuyaDevice';

/**
 * Everything needed to run devices over LAN without the Tuya cloud: ids, local keys,
 * schema with data point ids and the last known status. It holds secrets (local keys),
 * so it is written with mode 0600 and never logged.
 */
const SNAPSHOT_VERSION = 1;

interface SnapshotFile {
  version: number;
  devices: TuyaDevice[];
}

export function snapshotPath(persistPath: string) {
  return path.join(persistPath, 'TuyaLocalSnapshot.json');
}

export function isLocalCapable(device: TuyaDevice) {
  return !!device.local_key && !device.sub && !device.parent_id && device.category !== 'scene';
}

/** An RF / IR remote learned on a hub: it has no key of its own, it is operated through the hub. */
export function isHubRemote(device: TuyaDevice) {
  return !!device.parent_id && device.remote_keys !== undefined;
}

/** What the cloud-less mode needs: devices reachable over LAN and the remotes of the hubs. */
export function isSnapshotDevice(device: TuyaDevice) {
  return isLocalCapable(device) || isHubRemote(device);
}

export async function loadSnapshot(file: string): Promise<TuyaDevice[]> {
  try {
    const data = JSON.parse(await fs.promises.readFile(file, 'utf8')) as SnapshotFile;
    if (data.version !== SNAPSHOT_VERSION || !Array.isArray(data.devices)) {
      return [];
    }
    return data.devices.map(obj => new TuyaDevice(obj));
  } catch (error) {
    return [];
  }
}

/** Fresh cloud data wins, but information the cloud did not provide this time is kept. */
export function mergeSnapshot(previous: TuyaDevice[], fresh: TuyaDevice[]): TuyaDevice[] {
  return fresh.filter(isSnapshotDevice).map(device => {
    const old = previous.find(item => item.id === device.id);
    if (!old) {
      return device;
    }
    const merged = new TuyaDevice({ ...device });
    merged.local = { ...old.local, ...device.local };
    merged.schema = device.schema.map(schema => ({
      ...schema,
      dp_id: schema.dp_id ?? old.schema.find(item => item.code === schema.code)?.dp_id,
    }));
    return merged;
  });
}

export async function saveSnapshot(file: string, devices: TuyaDevice[]) {
  const previous = await loadSnapshot(file);
  const merged = mergeSnapshot(previous, devices);
  if (merged.length === 0) {
    return; // never replace a good snapshot with an empty one
  }
  const data: SnapshotFile = { version: SNAPSHOT_VERSION, devices: merged };

  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  await fs.promises.rename(tmp, file);
}
