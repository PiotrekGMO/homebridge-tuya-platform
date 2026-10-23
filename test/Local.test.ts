/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, test, jest, beforeEach, afterEach } from '@jest/globals';
import EventEmitter from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import TuyaLocalConnection, { TuyaLocalClient } from '../src/core/TuyaLocal';
import TuyaDevice, { TuyaDeviceSchemaMode, TuyaDeviceSchemaType } from '../src/device/TuyaDevice';
import TuyaLocalDeviceManager from '../src/device/TuyaLocalDeviceManager';
import { loadSnapshot, mergeSnapshot, saveSnapshot } from '../src/device/TuyaLocalSnapshot';

const log = { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() } as any;

class FakeClient extends EventEmitter implements TuyaLocalClient {
  static instances: FakeClient[] = [];
  static acceptVersion = '3.3';
  static deadIp?: string; // connecting to this address fails (the device got another one)
  static onlyIp?: string; // only this address reaches the device
  sets: Record<string, unknown>[] = [];
  device = { ip: '192.168.1.50' };

  constructor(public options: any) {
    super();
    FakeClient.instances.push(this);
  }

  async connect() {
    if (FakeClient.onlyIp && this.options.ip !== FakeClient.onlyIp) {
      throw new Error('ETIMEDOUT');
    }
    if (FakeClient.deadIp && this.options.ip === FakeClient.deadIp) {
      throw new Error('EHOSTUNREACH');
    }
    if (this.options.version !== FakeClient.acceptVersion) {
      throw new Error('Check device key or version');
    }
    return true;
  }

  async get() {
    return { dps: { '1': true, '9': 0 } };
  }

  async set({ data }: { data: Record<string, unknown> }) {
    this.sets.push(data);
    this.emit('data', { dps: data });
    return {};
  }

  disconnect() {
    this.emit('disconnected');
  }
}

const factory = (options: any) => new FakeClient(options) as unknown as TuyaLocalClient;
const flush = async () => { for (let i = 0; i < 20; i++) { await Promise.resolve(); } };

function makeDevice(extra: Partial<TuyaDevice> = {}) {
  return new TuyaDevice({
    id: 'dev1',
    uuid: 'dev1',
    name: 'Kuchnia',
    category: 'cz',
    product_id: 'p1',
    online: true,
    local_key: '0123456789abcdef',
    status: [{ code: 'switch_1', value: true }, { code: 'countdown_1', value: 0 }],
    schema: [
      { code: 'switch_1', dp_id: 1, mode: TuyaDeviceSchemaMode.READ_WRITE, type: TuyaDeviceSchemaType.Boolean, property: {} },
      { code: 'countdown_1', dp_id: 9, mode: TuyaDeviceSchemaMode.READ_WRITE, type: TuyaDeviceSchemaType.Integer,
        property: { min: 0, max: 86400, scale: 0, step: 1, unit: 's' } },
    ],
    ...extra,
  });
}

describe('TuyaLocalConnection', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    FakeClient.instances = [];
    FakeClient.acceptVersion = '3.3';
    FakeClient.deadIp = undefined;
    FakeClient.onlyIp = undefined;
  });
  afterEach(() => { jest.useRealTimers(); });

  test('connects, reports status, ip and probed version, and writes dps', async () => {
    const connection = new TuyaLocalConnection({ id: 'dev1', key: 'k' }, log, factory);
    const status = jest.fn();
    const version = jest.fn();
    const ip = jest.fn();
    connection.on('status', status);
    connection.on('version', version);
    connection.on('ip', ip);

    connection.start();
    await flush();

    expect(connection.connected).toBe(true);
    expect(status).toHaveBeenCalledWith({ '1': true, '9': 0 });
    expect(version).toHaveBeenCalledWith('3.3');
    expect(ip).toHaveBeenCalledWith('192.168.1.50');

    await connection.setDps({ '1': false });
    expect(FakeClient.instances[0].sets).toEqual([{ '1': false }]);
    expect(status).toHaveBeenLastCalledWith({ '1': false });
    connection.stop();
  });

  test('probes protocol versions when none is configured', async () => {
    FakeClient.acceptVersion = '3.4';
    const connection = new TuyaLocalConnection({ id: 'dev1', key: 'k' }, log, factory);
    const version = jest.fn();
    connection.on('version', version);

    connection.start();
    await flush();
    expect(connection.connected).toBe(false);

    jest.advanceTimersByTime(2000);
    await flush();
    expect(connection.connected).toBe(true);
    expect(version).toHaveBeenCalledWith('3.4');
    connection.stop();
  });

  test('reconnects after the device drops the connection', async () => {
    const connection = new TuyaLocalConnection({ id: 'dev1', key: 'k', version: '3.3' }, log, factory);
    connection.start();
    await flush();
    expect(connection.connected).toBe(true);

    FakeClient.instances[0].emit('disconnected');
    expect(connection.connected).toBe(false);

    jest.advanceTimersByTime(2000);
    await flush();
    expect(connection.connected).toBe(true);
    expect(FakeClient.instances).toHaveLength(2);
    connection.stop();
  });

  test('refuses to write while disconnected', async () => {
    const connection = new TuyaLocalConnection({ id: 'dev1', key: 'k' }, log, factory);
    await expect(connection.setDps({ '1': true })).rejects.toThrow();
  });

  test('forgets a remembered address that stopped answering and looks the device up again', async () => {
    FakeClient.deadIp = '192.168.1.9';
    const connection = new TuyaLocalConnection({ id: 'dev1', key: 'k', ip: '192.168.1.9', version: '3.3' }, log, factory);
    connection.start();
    await flush();
    expect(connection.connected).toBe(false);

    jest.advanceTimersByTime(2000); // second failure: the address is forgotten
    await flush();
    jest.advanceTimersByTime(4000);
    await flush();

    expect(connection.connected).toBe(true);
    expect(FakeClient.instances.at(-1)!['options'].ip).toBeUndefined();
    connection.stop();
  });

  test('finds the device among the hosts of the network when the UDP lookup finds nothing', async () => {
    FakeClient.onlyIp = '192.168.1.114';
    const candidates = jest.fn(async () => ['192.168.1.5', '192.168.1.114']);
    const connection = new TuyaLocalConnection({ id: 'dev1', key: 'k', version: '3.3', candidates }, log, factory);
    const ip = jest.fn();
    connection.on('ip', ip);
    connection.start();
    for (let i = 0; i < 4 && !connection.connected; i++) {
      await flush();
      jest.advanceTimersByTime(5000);
      await flush();
    }
    expect(connection.connected).toBe(true);
    expect(FakeClient.instances.map(client => client['options'].ip)).toEqual([undefined, '192.168.1.5', '192.168.1.114']);
    connection.stop();
  });

  test('does not try other protocol versions while the device has not been found', async () => {
    const versions: string[] = [];
    const lost = (options: any) => {
      versions.push(options.version);
      const client = new FakeClient(options);
      client.device = {} as any; // the lookup found nothing
      client.connect = async () => { throw new Error('no device'); };
      return client as unknown as TuyaLocalClient;
    };
    const connection = new TuyaLocalConnection({ id: 'dev1', key: 'k' }, log, lost);
    connection.start();
    for (let i = 0; i < 4; i++) {
      await flush();
      jest.advanceTimersByTime(60000);
    }
    expect(new Set(versions)).toEqual(new Set(['3.3']));
    connection.stop();
  });

  test('keeps an address that was configured by hand', async () => {
    FakeClient.deadIp = '192.168.1.9';
    const connection = new TuyaLocalConnection({ id: 'dev1', key: 'k', ip: '192.168.1.9', ipFixed: true, version: '3.3' }, log, factory);
    connection.start();
    for (let i = 0; i < 4; i++) {
      await flush();
      jest.advanceTimersByTime(60000);
    }
    expect(connection.connected).toBe(false);
    expect(FakeClient.instances.every(client => client['options'].ip === '192.168.1.9')).toBe(true);
    connection.stop();
  });

  test('a one-off write retries without the remembered address when it does not answer', async () => {
    FakeClient.deadIp = '192.168.1.9';
    const connection = new TuyaLocalConnection({ id: 'hub', key: 'k', ip: '192.168.1.9', version: '3.3' }, log, factory);
    const sent = await connection.sendOnce({ '201': 'x' }, 10);
    expect(sent).toBe(true);
    expect(FakeClient.instances).toHaveLength(2);
    expect(FakeClient.instances[1]['options'].ip).toBeUndefined();
  });
});

describe('TuyaLocalDeviceManager (no cloud)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    FakeClient.instances = [];
    FakeClient.acceptVersion = '3.3';
    FakeClient.deadIp = undefined;
  });
  afterEach(() => { jest.useRealTimers(); });

  test('starts from a snapshot, controls the device over LAN and maps pushed dps back to codes', async () => {
    const manager = new TuyaLocalDeviceManager(log);
    await manager.updateDevices([makeDevice()]);
    const updates: any[] = [];
    manager.on(TuyaLocalDeviceManager.Events.DEVICE_STATUS_UPDATE, (device, status) => updates.push([device.id, status]));

    manager.enableLocal(manager.devices, {}, factory);
    await flush();

    const device = manager.getDevice('dev1')!;
    expect(device.online).toBe(true);

    await manager.sendCommands('dev1', [{ code: 'switch_1', value: false }]);
    expect(FakeClient.instances[0].sets).toEqual([{ '1': false }]);
    expect(updates.at(-1)).toEqual(['dev1', [{ code: 'switch_1', value: false }]]);
    expect(device.status.find(item => item.code === 'switch_1')?.value).toBe(false);
    manager.local!.stop();
  });

  test('fails commands instead of calling the cloud when the device is unreachable', async () => {
    const manager = new TuyaLocalDeviceManager(log);
    await manager.updateDevices([makeDevice()]);
    FakeClient.acceptVersion = 'never';
    manager.enableLocal(manager.devices, {}, factory);
    await flush();

    await expect(manager.sendCommands('dev1', [{ code: 'switch_1', value: true }])).rejects.toThrow();
    manager.local!.stop();
  });

  test('adds an unsupported device by configuration only', async () => {
    const manager = new TuyaLocalDeviceManager(log);
    const devices = await manager.updateDevices([], [{
      id: 'thermo1',
      name: 'Termometr',
      key: 'abcdefghijklmnop',
      version: '3.3',
      category: 'wsdcg',
      schema: [
        { code: 'va_temperature', dp_id: 1, type: TuyaDeviceSchemaType.Integer, mode: 'ro',
          property: { min: -400, max: 1000, scale: 1, step: 1, unit: 'C' } },
        { code: 'va_humidity', dp_id: 2, type: TuyaDeviceSchemaType.Integer, mode: 'ro',
          property: { min: 0, max: 100, scale: 0, step: 1, unit: '%' } },
      ],
    }]);

    expect(devices).toHaveLength(1);
    expect(devices[0].online).toBe(false);
    // accessories need a status entry for every readable code before the first LAN update arrives
    expect(devices[0].status.map(item => item.code)).toEqual(['va_humidity', 'va_temperature']);

    manager.enableLocal(devices, {}, factory);
    await flush();
    expect(FakeClient.instances[0].options.key).toBe('abcdefghijklmnop');
    manager.local!.stop();
  });

  test('keeps a device cloud-only when it is excluded', async () => {
    const manager = new TuyaLocalDeviceManager(log);
    await manager.updateDevices([makeDevice()]);
    manager.enableLocal(manager.devices, { exclude: ['p1'] }, factory);
    await flush();
    expect(FakeClient.instances).toHaveLength(0);
  });
});

describe('local snapshot', () => {
  test('is saved with owner-only access, merged and never replaced by an empty list', async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tuya-snapshot-'));
    const file = path.join(dir, 'TuyaLocalSnapshot.json');

    await saveSnapshot(file, [makeDevice({ local: { ip: '192.168.1.10', version: '3.3' } })]);
    const hub = makeDevice({ id: 'hub', local_key: undefined });
    const noKey = makeDevice({ id: 'nokey', local_key: undefined });
    await saveSnapshot(file, [hub, noKey]); // nothing local-capable: old snapshot stays
    expect((await loadSnapshot(file)).map(item => item.id)).toEqual(['dev1']);

    await saveSnapshot(file, []);
    expect(await loadSnapshot(file)).toHaveLength(1);

    if (process.platform !== 'win32') {
      expect((await fs.promises.stat(file)).mode & 0o777).toBe(0o600);
    }
    await fs.promises.rm(dir, { recursive: true });
  });

  test('keeps dp ids and local info the cloud did not return this time', () => {
    const old = makeDevice({ local: { ip: '192.168.1.10', version: '3.4' } });
    const fresh = makeDevice();
    fresh.schema.forEach(schema => delete schema.dp_id);

    const [merged] = mergeSnapshot([old], [fresh]);
    expect(merged.local).toEqual({ ip: '192.168.1.10', version: '3.4' });
    expect(merged.schema.map(schema => schema.dp_id)).toEqual([1, 9]);
  });
});
