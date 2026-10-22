/* eslint-disable @typescript-eslint/no-explicit-any */
import EventEmitter from 'events';
import { describe, expect, test, jest } from '@jest/globals';
import TuyaOpenAPI from '../src/core/TuyaOpenAPI';
import TuyaDevice from '../src/device/TuyaDevice';
import TuyaHomeDeviceManager from '../src/device/TuyaHomeDeviceManager';
import IRBlindsAccessory from '../src/accessory/IRBlindsAccessory';

const log = { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() } as any;

const HUB = 'hub1';
const SHUTTERS = 'rf1';

function makeDevices() {
  return [
    new TuyaDevice({ id: HUB, name: 'Hub', category: 'wnykq', status: [], schema: [], sub: false }),
    new TuyaDevice({ id: SHUTTERS, name: 'Shutters', category: 'rf_venetian_blind', status: [], schema: [], sub: true }),
    new TuyaDevice({ id: 'zb1', name: 'Zigbee thing', category: 'wsdcg', status: [], schema: [], sub: true }),
  ];
}

function makeManager(responses: Record<string, any>) {
  const api = new TuyaOpenAPI('http://127.0.0.1', '', '', log);
  const get = jest.spyOn(api, 'get').mockImplementation((async (path: string) => {
    const hit = Object.entries(responses).find(([key]) => path.endsWith(key));
    return hit ? hit[1] : { success: false, code: 1, msg: 'unexpected ' + path };
  }) as any);
  const post = jest.spyOn(api, 'post').mockImplementation((async () => ({ success: true, result: true })) as any);
  return { manager: new TuyaHomeDeviceManager(api), get, post };
}

const keys = {
  success: true,
  result: {
    category_id: 11, brand_id: 0, remote_index: 1, single_air: false, duplicate_power: false, key_list: [
      { key: 'stop', key_id: 3, key_name: 'stop', standard_key: false },
      { key: 'power_on', key_id: 1, key_name: 'on', standard_key: false },
      { key: 'power_off', key_id: 2, key_name: 'off', standard_key: false },
    ],
  },
};
const codes = {
  success: true,
  result: [
    { id: 3, key: 'stop', code: '{"rf_type":"sub_2g","key1":{"code":"c3"}}' },
    { id: 1, key: 'power_on', code: '{"rf_type":"sub_2g","key1":{"code":"c1"}}' },
    { id: 2, key: 'power_off', code: '{"rf_type":"sub_2g","key1":{"code":"c2"}}' },
  ],
};

const expected = (c: string) => JSON.stringify({
  control: 'rfstudy_send', rf_type: 'sub_2g', mode: 0,
  key1: { times: 6, intervals: 0, ver: '2', delay: 0, code: c },
  feq: 0, rate: 0, ver: '2',
});

const responses = {
  [`/infrareds/${HUB}/remotes`]: { success: true, result: [] }, // RF remotes are not listed here
  [`/devices/${HUB}/sub-devices`]: { success: true, result: [{ id: SHUTTERS }, { id: 'zb1' }] },
  [`/remotes/${SHUTTERS}/keys`]: keys,
  [`/remotes/${SHUTTERS}/learning-codes`]: codes,
};

describe('RF remotes on an IR+RF hub', () => {
  test('are found through the hub sub-devices, with keys and learned codes', async () => {
    const { manager } = makeManager(responses);
    const devices = makeDevices();
    await manager.updateInfraredRemotes(devices);

    const shutters = devices[1];
    expect(shutters.parent_id).toBe(HUB);
    expect(shutters.isRFRemoteControl()).toBe(true);
    expect(shutters.remote_keys?.key_list.map(key => [key.key, !!key.learning_code])).toEqual([
      ['stop', true], ['power_on', true], ['power_off', true],
    ]);
    expect(devices[2].remote_keys).toBeUndefined(); // not an RF remote, left alone
  });

  test('a hub hidden through a category override is still used to reach its remotes', async () => {
    const { manager } = makeManager(responses);
    const devices = makeDevices();
    devices[0].original_category = devices[0].category;
    devices[0].category = 'hidden';
    await manager.updateInfraredRemotes(devices);

    expect(devices[1].parent_id).toBe(HUB);
    expect(devices[1].remote_keys?.key_list).toHaveLength(3);
  });

  test('without a LAN link RF keys go to the hub as its ir_send property, with ver 2', async () => {
    const { manager, post } = makeManager(responses);
    const devices = makeDevices();
    await manager.updateInfraredRemotes(devices);

    const shutters = devices[1];
    const res = await manager.sendInfraredKey(shutters, shutters.remote_keys!.key_list.find(key => key.key === 'power_on')!);
    expect(res.success).toBe(true);
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(`/v2.0/cloud/thing/${HUB}/shadow/properties/issue`, {
      properties: JSON.stringify({ ir_send: expected('c1') }),
    });
  });

  test('RF keys are written to the hub over LAN first, connecting only for the write', async () => {
    const { manager, post } = makeManager(responses);
    const devices = makeDevices();
    await manager.updateInfraredRemotes(devices);

    const sets: any[] = [];
    const clients: any[] = [];
    const factory = (options: any) => {
      const client = new EventEmitter() as any;
      client.options = options;
      client.connect = jest.fn(async () => true);
      client.set = jest.fn(async (arg: any) => { sets.push(arg); return {}; });
      client.disconnect = jest.fn();
      clients.push(client);
      return client;
    };
    devices[0].local_key = '0123456789abcdef';
    manager.enableLocal([devices[0]], { localDevices: [{ id: HUB, ip: '192.168.1.142', version: '3.3' }] }, factory as any);
    expect(clients).toHaveLength(0); // no standing connection to the hub

    const shutters = devices[1];
    const res = await manager.sendInfraredKey(shutters, shutters.remote_keys!.key_list.find(key => key.key === 'power_off')!);
    expect(res.success).toBe(true);
    expect(post).not.toHaveBeenCalled();
    expect(clients).toHaveLength(1);
    expect(clients[0].options).toMatchObject({ ip: '192.168.1.142', version: '3.3' });
    expect(sets).toEqual([{ multiple: true, data: { '201': expected('c2') } }]);
    expect(clients[0].disconnect).toHaveBeenCalled();
  });

  test('RF keys fall back to the cloud when the hub cannot be reached over LAN', async () => {
    const { manager, post } = makeManager(responses);
    const devices = makeDevices();
    await manager.updateInfraredRemotes(devices);

    const factory = () => {
      const client = new EventEmitter() as any;
      client.connect = jest.fn(async () => { throw new Error('ECONNREFUSED'); });
      client.disconnect = jest.fn();
      return client;
    };
    devices[0].local_key = '0123456789abcdef';
    manager.enableLocal([devices[0]], { localDevices: [{ id: HUB, ip: '192.168.1.142', version: '3.3' }] }, factory as any);

    const shutters = devices[1];
    const res = await manager.sendInfraredKey(shutters, shutters.remote_keys!.key_list.find(key => key.key === 'power_off')!);
    expect(res.success).toBe(true);
    expect(post).toHaveBeenCalledTimes(1);
  });

  test('falls back to the device commands API when the thing model rejects the property', async () => {
    const { manager, post } = makeManager(responses);
    post.mockImplementation((async (path: string) => path.includes('/shadow/')
      ? { success: false, code: 2008, msg: 'rejected' } : { success: true, result: true }) as any);
    const devices = makeDevices();
    await manager.updateInfraredRemotes(devices);

    const shutters = devices[1];
    const res = await manager.sendInfraredKey(shutters, shutters.remote_keys!.key_list.find(key => key.key === 'stop')!);
    expect(res.success).toBe(true);
    expect(post).toHaveBeenLastCalledWith(`/v1.0/devices/${HUB}/commands`, {
      commands: [{ code: 'ir_send', value: expected('c3') }],
    });
  });

  test('reports failure when neither path is accepted', async () => {
    const { manager, post } = makeManager(responses);
    post.mockImplementation((async () => ({ success: false, code: 1, msg: 'nope' })) as any);
    const devices = makeDevices();
    await manager.updateInfraredRemotes(devices);

    const shutters = devices[1];
    const res = await manager.sendInfraredKey(shutters, shutters.remote_keys!.key_list[0]);
    expect(res.success).toBe(false);
  });

  test('blinds with open/close keys get the blinds accessory, other RF remotes do not', async () => {
    const { manager } = makeManager(responses);
    const devices = makeDevices();
    await manager.updateInfraredRemotes(devices);
    expect(IRBlindsAccessory.supports(devices[1])).toBe(true);

    const socket = new TuyaDevice({ ...devices[1], remote_keys: { ...devices[1].remote_keys!, category_id: 12 } } as any);
    expect(IRBlindsAccessory.supports(socket)).toBe(false);

    const noClose = new TuyaDevice({
      ...devices[1],
      remote_keys: { ...devices[1].remote_keys!, key_list: devices[1].remote_keys!.key_list.filter(key => key.key !== 'power_off') },
    } as any);
    expect(IRBlindsAccessory.supports(noClose)).toBe(false);
  });
});
