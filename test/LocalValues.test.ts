/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, jest, test } from '@jest/globals';
import TuyaDevice, { TuyaDeviceSchema, TuyaDeviceSchemaMode, TuyaDeviceSchemaType } from '../src/device/TuyaDevice';
import TuyaLocalLink from '../src/device/TuyaLocalLink';
import { decodeLocalValue, encodeLocalValue } from '../src/device/TuyaLocalValues';

const log = { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() } as any;

const colourV2: TuyaDeviceSchema = {
  code: 'colour_data', dp_id: 24, mode: TuyaDeviceSchemaMode.READ_WRITE, type: TuyaDeviceSchemaType.Json,
  property: { h: { min: 0, max: 360 }, s: { min: 0, max: 1000 }, v: { min: 0, max: 1000 } },
};
const colourV1: TuyaDeviceSchema = {
  ...colourV2, code: 'colour_data',
  property: { h: { min: 0, max: 360 }, s: { min: 0, max: 255 }, v: { min: 0, max: 255 } },
};

describe('colour data translation', () => {
  test('the device form of the strip is turned into the cloud JSON that the accessories parse', () => {
    const value = decodeLocalValue(colourV2, '00dc03e803e8') as string;
    expect(JSON.parse(value)).toEqual({ h: 220, s: 1000, v: 1000 });
  });

  test('a colour sent by an accessory goes to the device in its own form', () => {
    expect(encodeLocalValue(colourV2, JSON.stringify({ h: 220, s: 1000, v: 1000 }))).toBe('00dc03e803e8');
    expect(encodeLocalValue(colourV2, JSON.stringify({ h: 0, s: 500, v: 10 }))).toBe('000001f4000a');
  });

  test('the older 0-255 variant carries RGB first and is translated both ways', () => {
    const device = encodeLocalValue(colourV1, JSON.stringify({ h: 0, s: 255, v: 255 })) as string;
    expect(device).toBe('ff00000000ffff');
    expect(JSON.parse(decodeLocalValue(colourV1, device) as string)).toEqual({ h: 0, s: 255, v: 255 });
  });

  test('values that are not colour data, or already have the cloud form, are left alone', () => {
    const json = JSON.stringify({ h: 1, s: 2, v: 3 });
    expect(decodeLocalValue(colourV2, json)).toBe(json);
    expect(decodeLocalValue({ ...colourV2, code: 'scene_data' }, '000d0d00000003e803e800000000')).toBe('000d0d00000003e803e800000000');
    expect(encodeLocalValue({ ...colourV2, code: 'switch_led', type: TuyaDeviceSchemaType.Boolean }, true)).toBe(true);
    expect(encodeLocalValue(colourV2, '00dc03e803e8')).toBe('00dc03e803e8'); // already the device form
  });
});

describe('local link with a colour device', () => {
  const device = new TuyaDevice({
    id: 'strip', name: 'Pasek', category: 'dd', status: [], sub: false,
    schema: [
      { code: 'switch_led', dp_id: 20, mode: TuyaDeviceSchemaMode.READ_WRITE, type: TuyaDeviceSchemaType.Boolean, property: {} },
      colourV2,
    ],
  });

  test('status pushed over LAN reaches the accessories in the cloud form', () => {
    const link = new TuyaLocalLink(log);
    const status = link.toStatus(device, { '20': true, '24': '00dc03e803e8' });
    expect(status[0]).toEqual({ code: 'switch_led', value: true });
    expect(JSON.parse(status[1].value as string)).toEqual({ h: 220, s: 1000, v: 1000 });
  });

  test('commands from the accessories are written in the device form', () => {
    const link = new TuyaLocalLink(log);
    const dps = link.toDps(device, [{ code: 'colour_data', value: JSON.stringify({ h: 120, s: 800, v: 600 }) }]);
    expect(dps).toEqual({ '24': '007803200258' });
  });
});
