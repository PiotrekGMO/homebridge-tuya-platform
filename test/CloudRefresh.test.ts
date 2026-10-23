/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, jest, test } from '@jest/globals';
import TuyaOpenAPI from '../src/core/TuyaOpenAPI';
import TuyaDevice, { TuyaDeviceSchemaMode, TuyaDeviceSchemaType } from '../src/device/TuyaDevice';
import TuyaHomeDeviceManager from '../src/device/TuyaHomeDeviceManager';

const log = { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() } as any;

function thermometer() {
  return new TuyaDevice({
    id: 'thermo', name: 'Garaż Termometr', category: 'wsdcg', sub: false, online: true,
    status: [{ code: 'temp_current', value: 126 }, { code: 'humidity_value', value: 72 }],
    schema: [
      { code: 'temp_current', dp_id: 27, mode: TuyaDeviceSchemaMode.READ_ONLY, type: TuyaDeviceSchemaType.Integer, property: {} },
      { code: 'humidity_value', dp_id: 46, mode: TuyaDeviceSchemaMode.READ_ONLY, type: TuyaDeviceSchemaType.Integer, property: {} },
    ],
  });
}

function makeManager(properties: Array<{ code: string; value: unknown }>) {
  const api = new TuyaOpenAPI('http://127.0.0.1', '', '', log);
  const get = jest.spyOn(api, 'get').mockImplementation((async () => ({ success: true, result: { properties } })) as any);
  const manager = new TuyaHomeDeviceManager(api);
  manager.devices = [thermometer()];
  return { manager, get };
}

describe('status that arrives by data point id', () => {
  test('is applied to the matching code, so a notification from a DP-only product is not lost', () => {
    const { manager } = makeManager([]);
    const updates: any[] = [];
    manager.on(TuyaHomeDeviceManager.Events.DEVICE_STATUS_UPDATE, (device, status) => updates.push(status));

    manager.applyStatusUpdate('thermo', [{ code: '27', value: 82 } as any, { code: '46', value: 80 } as any]);

    const device = manager.getDevice('thermo')!;
    expect(device.status.find(item => item.code === 'temp_current')?.value).toBe(82);
    expect(device.status.find(item => item.code === 'humidity_value')?.value).toBe(80);
    expect(updates[0].map((item: any) => item.code)).toEqual(['temp_current', 'humidity_value']);
  });
});

describe('cloud refresh of cloud-only devices', () => {
  test('values that changed in the cloud reach the accessories', async () => {
    const { manager } = makeManager([{ code: 'temp_current', value: 82 }, { code: 'humidity_value', value: 72 }]);
    const updates: any[] = [];
    manager.on(TuyaHomeDeviceManager.Events.DEVICE_STATUS_UPDATE, (device, status) => updates.push(status));

    await manager.refreshFromCloud();

    expect(manager.getDevice('thermo')!.status.find(item => item.code === 'temp_current')?.value).toBe(82);
    expect(updates).toEqual([[{ code: 'temp_current', value: 82 }]]); // only what changed
  });

  test('a device that is connected over LAN is left alone', async () => {
    const { manager, get } = makeManager([{ code: 'temp_current', value: 82 }]);
    (manager as any).local = { isConnected: () => true };
    await manager.refreshFromCloud();
    expect(get).not.toHaveBeenCalled();
  });

  test('without the cloud nothing is requested, and 0 minutes turns the refresh off', () => {
    const { manager } = makeManager([]);
    jest.useFakeTimers();
    manager.startCloudRefresh(0);
    expect((manager as any).refreshTimer).toBeUndefined();
    manager.cloud = false;
    manager.startCloudRefresh(10);
    expect((manager as any).refreshTimer).toBeUndefined();
    jest.useRealTimers();
  });
});
