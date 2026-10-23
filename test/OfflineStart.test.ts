/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, jest, test } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import TuyaDevice from '../src/device/TuyaDevice';
import TuyaLocalDeviceManager from '../src/device/TuyaLocalDeviceManager';
import { saveSnapshot, snapshotPath } from '../src/device/TuyaLocalSnapshot';
import { TuyaPlatform } from '../src/platform';

jest.mock('../src/accessory/AccessoryFactory', () => ({
  __esModule: true,
  default: { createAccessory: (platform: any, accessory: any, device: any) => ({ accessory, device, onDeviceStatusUpdate: jest.fn() }) },
}));

const log = { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() } as any;

const HUB = 'hub1';

function devices() {
  const light = new TuyaDevice({
    id: 'light1', uuid: 'light1', name: 'Kuchnia', category: 'cz', product_id: 'p1', online: true, sub: false,
    local_key: '0123456789abcdef', local: { ip: '127.0.0.1', version: '3.3' },
    status: [{ code: 'switch_1', value: true }],
    schema: [{ code: 'switch_1', dp_id: 1, mode: 'rw', type: 'Boolean', property: {} }],
  } as any);
  const hub = new TuyaDevice({
    id: HUB, uuid: HUB, name: 'Hub', category: 'hidden', original_category: 'wnykq', product_id: 'hubp', online: true, sub: false,
    local_key: 'fedcba9876543210', local: { ip: '127.0.0.1', version: '3.3' }, status: [], schema: [],
  } as any);
  const shutters = new TuyaDevice({
    id: 'rf1', uuid: 'rf1', name: 'Shutters', category: 'rf_venetian_blind', product_id: 'rfp', online: true, sub: true,
    parent_id: HUB, status: [], schema: [],
    remote_keys: {
      category_id: 11, brand_id: 0, remote_index: 1, single_air: false, duplicate_power: false,
      key_list: [{ key: 'power_off', key_id: 2, key_name: 'off', standard_key: false, learning_code: '{"rf_type":"sub_2g","key1":{"code":"c2"}}' }],
    },
  } as any);
  return [light, hub, shutters];
}

describe('start without the Tuya cloud', () => {
  test('the devices and the shutters come back from the snapshot and a key goes over LAN through the hub', async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tuya-offline-'));
    await saveSnapshot(snapshotPath(dir), devices());

    const registered: any[] = [];
    const api: any = {
      hap: { Service: {}, Characteristic: {}, uuid: { generate: (seed: string) => `uuid-${seed}` } },
      user: { persistPath: () => dir },
      on: jest.fn(),
      platformAccessory: class { context: any = {}; constructor(public displayName: string, public UUID: string) { /* */ } },
      registerPlatformAccessories: (_plugin: string, _platform: string, accessories: any[]) => registered.push(...accessories),
      unregisterPlatformAccessories: jest.fn(),
      updatePlatformAccessories: jest.fn(),
    };
    const config: any = {
      platform: 'TuyaPlatform',
      options: {
        projectType: '2', endpoint: 'http://127.0.0.1:1', // nothing listens here: the cloud is unreachable
        accessId: 'id', accessKey: 'key', countryCode: 48, username: 'u', password: 'p', appSchema: 'tuyaSmart',
        local: { enabled: true },
        deviceOverrides: [{ id: HUB, category: 'hidden' }],
      },
    };

    const platform = new TuyaPlatform(log, config, api);
    await platform.initDevices();

    expect(platform.deviceManager).toBeInstanceOf(TuyaLocalDeviceManager);
    expect(platform.deviceManager!.cloud).toBe(false);
    expect(registered.map(accessory => accessory.displayName).sort()).toEqual(['Kuchnia', 'Shutters']); // the hub stays hidden

    const manager = platform.deviceManager!;
    const shutters = manager.getDevice('rf1')!;
    expect(shutters.isRFRemoteControl()).toBe(true);
    expect(manager.getDevice(HUB)!.isIRControlHub()).toBe(true);
    expect((manager.local as any).entries.get(HUB).persistent).toBe(false); // contacted only when a key is sent
    expect(manager.local!.has(HUB)).toBe(true); // reachable for the key

    manager.local!.stop();
    await fs.promises.rm(dir, { recursive: true });
  }, 20000);
});
