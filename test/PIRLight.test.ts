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
  accessory.ignoreLampUntil = 0;
  accessory.saveContext = jest.fn();
  accessory.accessory = { context: {} };
  accessory.getStatus = (code: string) => accessory.device.status.find((item: any) => item.code === code);
  return accessory;
}

describe('PIRLightAccessory manual values', () => {
  test('the first start remembers what the lamp reports as the manual values', () => {
    const accessory = makeAccessory(false, 'manual');
    accessory.device.status.push({ code: 'bright_value', value: 540 }, { code: 'temp_value', value: 300 });
    accessory.initManualValues();
    expect(accessory.accessory.context.manual).toEqual({ bright_value: 540, temp_value: 300 });
  });

  test('in the automatic mode the slider keeps the manual value, whatever the lamp reports', async () => {
    const accessory = makeAccessory(false, 'auto');
    accessory.accessory.context.manual = { bright_value: 540 };
    accessory.device.status.push({ code: 'bright_value', value: 10 }); // the manager stored the lamp's own value
    await accessory.onDeviceStatusUpdate([{ code: 'bright_value', value: 10 }]);

    expect(accessory.getStatus('bright_value').value).toBe(540);
    expect(accessory.accessory.context.manual.bright_value).toBe(540);
  });

  test('in the manual mode the lamp\'s value becomes the remembered one', async () => {
    const accessory = makeAccessory(true, 'manual');
    accessory.accessory.context.manual = { bright_value: 540 };
    accessory.device.status.push({ code: 'bright_value', value: 800 });
    await accessory.onDeviceStatusUpdate([{ code: 'bright_value', value: 800 }]);

    expect(accessory.accessory.context.manual.bright_value).toBe(800);
    expect(accessory.saveContext).toHaveBeenCalled();
  });

  test('right after a mode change the lamp\'s own values do not replace the remembered ones', async () => {
    const accessory = makeAccessory(true, 'manual');
    accessory.accessory.context.manual = { bright_value: 540 };
    accessory.ignoreLampUntil = Date.now() + 2000;
    accessory.device.status.push({ code: 'bright_value', value: 10 });
    await accessory.onDeviceStatusUpdate([{ code: 'bright_value', value: 10 }]);

    expect(accessory.accessory.context.manual.bright_value).toBe(540);
    expect(accessory.getStatus('bright_value').value).toBe(540);
  });

  test('leaving the automatic mode gives the lamp the remembered values, except those being set', async () => {
    const accessory = makeAccessory(false, 'manual');
    accessory.device.schema = [{ code: 'bright_value' }, { code: 'temp_value' }];
    accessory.accessory.context.manual = { bright_value: 540, temp_value: 300 };
    const send = jest.spyOn(Object.getPrototypeOf(PIRLightAccessory.prototype), 'sendCommands').mockResolvedValue(undefined as never);

    await accessory.restoreManualValues([{ code: 'temp_value', value: 120 }]);
    expect(send).toHaveBeenCalledWith([{ code: 'bright_value', value: 540 }], false);
    send.mockRestore();
  });
});

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
