/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, test, jest } from '@jest/globals';
import TuyaOpenAPI from '../src/core/TuyaOpenAPI';
import TuyaDevice, { TuyaDeviceSchemaMode, TuyaDeviceSchemaType } from '../src/device/TuyaDevice';
import TuyaHomeDeviceManager from '../src/device/TuyaHomeDeviceManager';
import { parseThingModel } from '../src/device/ThingModel';

const log = { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() } as any;

const thermometerModel = {
  model: JSON.stringify({
    services: [{
      code: '',
      properties: [
        { abilityId: 1, code: 'temp_current', accessMode: 'ro', typeSpec: { type: 'value', min: -400, max: 1000, scale: 1, step: 1, unit: '℃' } },
        { abilityId: 2, code: 'humidity_value', accessMode: 'ro', typeSpec: { type: 'value', min: 0, max: 100, scale: 0, step: 1, unit: '%' } },
        { abilityId: 3, code: 'battery_state', accessMode: 'ro', typeSpec: { type: 'enum', range: ['low', 'middle', 'high'] } },
        { abilityId: 9, code: 'switch', accessMode: 'rw', typeSpec: { type: 'bool' } },
        { abilityId: 10, code: 'raw_blob', accessMode: 'ro', typeSpec: { type: 'raw' } },
      ],
    }],
  }),
};

function makeManager(responses: Record<string, any>) {
  const api = new TuyaOpenAPI('http://127.0.0.1', '', '', log);
  jest.spyOn(api, 'get').mockImplementation((async (path: string) => {
    const res = Object.entries(responses).find(([key]) => path.endsWith(key));
    return res ? res[1] : { success: false, code: 2009, msg: 'not found' };
  }) as any);
  return new TuyaHomeDeviceManager(api);
}

function makeDevice() {
  return new TuyaDevice({ id: 'd1', name: 'Garaż Termometr', category: 'tdq', product_id: 'x3o8', status: [], schema: [], sub: false });
}

describe('parseThingModel', () => {
  test('maps properties to schema with data point ids and skips raw', () => {
    const schema = parseThingModel(thermometerModel);
    expect(schema.map(item => item.code)).toEqual(['battery_state', 'humidity_value', 'switch', 'temp_current']);

    const temp = schema.find(item => item.code === 'temp_current')!;
    expect(temp).toEqual({
      code: 'temp_current', dp_id: 1, mode: TuyaDeviceSchemaMode.READ_ONLY, type: TuyaDeviceSchemaType.Integer,
      property: { min: -400, max: 1000, scale: 1, step: 1, unit: '℃' },
    });
    expect(schema.find(item => item.code === 'battery_state')!.property).toEqual({ range: ['low', 'middle', 'high'] });
    expect(schema.find(item => item.code === 'switch')!.mode).toBe(TuyaDeviceSchemaMode.READ_WRITE);
  });

  test('accepts the model as an object as well as a JSON string', () => {
    expect(parseThingModel({ model: JSON.parse(thermometerModel.model) })).toHaveLength(4);
  });
});

describe('TuyaDeviceManager.loadDeviceSchema', () => {
  test('falls back to the thing model when the specification is not supported', async () => {
    const manager = makeManager({
      '/specifications': { success: false, code: 2009, msg: 'not support this device' },
      '/model': { success: true, result: thermometerModel },
      '/shadow/properties': { success: true, result: { properties: [
        { code: 'temp_current', dp_id: 1, value: 211 },
        { code: 'humidity_value', dp_id: 2, value: 77 },
        { code: 'unknown_code', dp_id: 99, value: 1 },
      ] } },
    });
    const device = makeDevice();
    await manager.loadDeviceSchema(device);

    expect(device.schema.find(item => item.code === 'temp_current')?.dp_id).toBe(1);
    expect(device.status).toEqual([
      { code: 'humidity_value', value: 77 },
      { code: 'temp_current', value: 211 },
    ]);
  });

  test('keeps the standard specification when the cloud supports the device', async () => {
    const manager = makeManager({
      '/specifications': { success: true, result: {
        status: [{ code: 'switch_1', type: 'Boolean', values: '{}', dp_id: 1 }],
        functions: [{ code: 'switch_1', type: 'Boolean', values: '{}', dp_id: 1 }],
      } },
    });
    const device = makeDevice();
    await manager.loadDeviceSchema(device);
    expect(device.schema.map(item => item.code)).toEqual(['switch_1']);
    expect(device.schema[0].dp_id).toBe(1);
    expect(device.status).toEqual([]);
  });

  test('leaves the device without schema when the thing model is not available either', async () => {
    const manager = makeManager({});
    const device = makeDevice();
    await manager.loadDeviceSchema(device);
    expect(device.schema).toEqual([]);
  });
});
