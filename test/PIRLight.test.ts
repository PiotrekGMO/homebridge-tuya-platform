import { describe, expect, jest, test } from '@jest/globals';
import TuyaDevice, { TuyaDeviceSchemaMode, TuyaDeviceSchemaType } from '../src/device/TuyaDevice';
import PIRLightAccessory, { withManualMode } from '../src/accessory/PIRLightAccessory';

function makeLamp(withMode = true) {
  return new TuyaDevice({
    id: 'lamp1', name: 'Garaż Lampa', category: 'gyd', status: [], sub: false,
    schema: [
      { code: 'switch_led', dp_id: 20, mode: TuyaDeviceSchemaMode.READ_WRITE, type: TuyaDeviceSchemaType.Boolean, property: {} },
      ...(withMode ? [{
        code: 'device_mode', dp_id: 51, mode: TuyaDeviceSchemaMode.READ_WRITE, type: TuyaDeviceSchemaType.Enum,
        property: { range: ['auto', 'manual'] },
      }] : []),
    ],
  });
}

function makeAccessory(on: boolean, mode: string) {
  const accessory: any = Object.create(PIRLightAccessory.prototype);
  accessory.device = { status: [{ code: 'switch_led', value: on }, { code: 'device_mode', value: mode }] };
  accessory.log = { debug: jest.fn() };
  accessory.updateAllValues = jest.fn();
  accessory.sent = new Map(); // field initialisers do not run on Object.create
  accessory.getStatus = (code: string) => accessory.device.status.find((item: any) => item.code === code);
  return accessory;
}

describe('PIRLightAccessory slider echoes', () => {
  test('a late answer with an older value does not move the slider back', async () => {
    const accessory = makeAccessory(true, 'manual');
    accessory.device.status.push({ code: 'bright_value', value: 520 });
    accessory.sent = new Map([['bright_value', { value: 540, at: Date.now() }]]);
    // the lamp answers an earlier step of the drag, the manager already stored it
    accessory.device.status.find((item: any) => item.code === 'bright_value').value = 490;
    await accessory.onDeviceStatusUpdate([{ code: 'bright_value', value: 490 }]);

    expect(accessory.getStatus('bright_value').value).toBe(540);
  });

  test('the answer for the last value, and later changes by the lamp itself, are passed on', async () => {
    const accessory = makeAccessory(true, 'manual');
    accessory.device.status.push({ code: 'bright_value', value: 540 });
    accessory.sent = new Map([['bright_value', { value: 540, at: Date.now() }]]);
    await accessory.onDeviceStatusUpdate([{ code: 'bright_value', value: 540 }]);
    expect(accessory.getStatus('bright_value').value).toBe(540);

    accessory.sent = new Map([['bright_value', { value: 540, at: Date.now() - 5000 }]]);
    accessory.device.status.find((item: any) => item.code === 'bright_value').value = 100;
    await accessory.onDeviceStatusUpdate([{ code: 'bright_value', value: 100 }]);
    expect(accessory.getStatus('bright_value').value).toBe(100);
  });
});

describe('PIRLightAccessory', () => {
  test('is used only for lamps that have an auto / manual mode', () => {
    expect(PIRLightAccessory.supports(makeLamp())).toBe(true);
    expect(PIRLightAccessory.supports(makeLamp(false))).toBe(false);
  });

  test('a light command in the automatic mode switches the lamp to manual first', () => {
    const commands = [{ code: 'switch_led', value: true }, { code: 'bright_value', value: 500 }];
    expect(withManualMode(commands, 'auto')).toEqual([{ code: 'device_mode', value: 'manual' }, ...commands]);
  });

  test('light commands are left alone in the manual mode or when the mode is unknown', () => {
    const commands = [{ code: 'switch_led', value: false }];
    expect(withManualMode(commands, 'manual')).toBe(commands);
    expect(withManualMode(commands, undefined)).toBe(commands);
  });

  test('changing the mode itself, or settings that are not the light, never forces manual', () => {
    const mode = [{ code: 'device_mode', value: 'auto' }];
    expect(withManualMode(mode, 'auto')).toBe(mode);
    const settings = [{ code: 'pir_delay', value: 60 }];
    expect(withManualMode(settings, 'auto')).toBe(settings);
  });
});
