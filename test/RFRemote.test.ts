/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, test, jest } from '@jest/globals';
import TuyaOpenAPI from '../src/core/TuyaOpenAPI';
import TuyaDevice from '../src/device/TuyaDevice';
import TuyaHomeDeviceManager from '../src/device/TuyaHomeDeviceManager';
import IRWindowCoveringAccessory from '../src/accessory/IRWindowCoveringAccessory';

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

  test('keys are sent as learned codes through the infrared API', async () => {
    const { manager, post } = makeManager(responses);
    const devices = makeDevices();
    await manager.updateInfraredRemotes(devices);

    const shutters = devices[1];
    await manager.sendInfraredKey(shutters, shutters.remote_keys!.key_list.find(key => key.key === 'power_on')!);
    expect(post).toHaveBeenCalledWith(
      `/v2.0/infrareds/${HUB}/remotes/${SHUTTERS}/learning-codes`,
      { code: '{"rf_type":"sub_2g","key1":{"code":"c1"}}' },
    );
  });

  test('blinds with open/close keys get the window covering accessory, other RF remotes do not', async () => {
    const { manager } = makeManager(responses);
    const devices = makeDevices();
    await manager.updateInfraredRemotes(devices);
    expect(IRWindowCoveringAccessory.supports(devices[1])).toBe(true);

    const socket = new TuyaDevice({ ...devices[1], remote_keys: { ...devices[1].remote_keys!, category_id: 12 } } as any);
    expect(IRWindowCoveringAccessory.supports(socket)).toBe(false);

    const noClose = new TuyaDevice({
      ...devices[1],
      remote_keys: { ...devices[1].remote_keys!, key_list: devices[1].remote_keys!.key_list.filter(key => key.key !== 'power_off') },
    } as any);
    expect(IRWindowCoveringAccessory.supports(noClose)).toBe(false);
  });
});
