import TuyaDevice, { TuyaDeviceSchemaEnumProperty, TuyaDeviceSchemaType, TuyaDeviceStatus } from '../device/TuyaDevice';
import LightAccessory from './LightAccessory';
import { configureLight } from './characteristic/Light';
import { configureName } from './characteristic/Name';

const SCHEMA_CODE = {
  ON: ['switch_led'],
  BRIGHTNESS: ['bright_value', 'bright_value_v2'],
  COLOR_TEMP: ['temp_value', 'temp_value_v2'],
  COLOR: ['colour_data', 'colour_data_v2'],
  WORK_MODE: ['work_mode'],
  MODE: ['device_mode'],
};

const MODE_SETTLE_MS = 400;
const ECHO_WINDOW_MS = 1500;

// Values moved with a slider, whose delayed answers must not move the slider back.
const SLIDER_CODES = [...SCHEMA_CODE.BRIGHTNESS, ...SCHEMA_CODE.COLOR_TEMP];

// Commands that only make sense when the lamp is controlled by hand.
const MANUAL_CODES = [
  ...SCHEMA_CODE.ON, ...SCHEMA_CODE.BRIGHTNESS, ...SCHEMA_CODE.COLOR_TEMP, ...SCHEMA_CODE.COLOR, ...SCHEMA_CODE.WORK_MODE,
];

/**
 * In the automatic mode the motion sensor switches the lamp and changes its brightness, overriding
 * whatever HomeKit sends. So a command for the light first switches the lamp to manual mode, and the
 * automatic mode itself is a switch of its own.
 */
export function withManualMode(commands: TuyaDeviceStatus[], currentMode?: string | number | boolean) {
  if (currentMode !== 'auto' || !commands.some(command => MANUAL_CODES.includes(command.code))) {
    return commands;
  }
  return [{ code: 'device_mode', value: 'manual' } as TuyaDeviceStatus, ...commands];
}

/**
 * Lamps with a motion sensor and an automatic / manual mode. The lamp itself lights up when it goes to
 * manual and goes dark when it goes to automatic (the sensor lights it on motion), and that is what
 * HomeKit shows.
 */
export default class PIRLightAccessory extends LightAccessory {

  private autoService?;
  private sent = new Map<string, { value: TuyaDeviceStatus['value']; at: number }>(); // last slider values sent

  static supports(device: TuyaDevice) {
    const mode = device.schema.find(schema => schema.code === SCHEMA_CODE.MODE[0]);
    const range = (mode?.property as TuyaDeviceSchemaEnumProperty | undefined)?.range ?? [];
    return mode?.type === TuyaDeviceSchemaType.Enum
      && range.includes('auto') && range.includes('manual')
      && device.schema.some(schema => schema.code === SCHEMA_CODE.ON[0]);
  }

  configureServices() {
    const service = this.accessory.getService(this.Service.Lightbulb)
      || this.accessory.addService(this.Service.Lightbulb);

    configureLight(
      this,
      service,
      this.getSchema(...SCHEMA_CODE.ON),
      this.getSchema(...SCHEMA_CODE.BRIGHTNESS),
      this.getSchema(...SCHEMA_CODE.COLOR_TEMP),
      this.getSchema(...SCHEMA_CODE.COLOR),
      this.getSchema(...SCHEMA_CODE.WORK_MODE),
    );

    // The radar as a motion sensor only clutters the lamp, the automatic mode has its own switch.
    const motion = this.accessory.getService(this.Service.MotionSensor);
    if (motion) {
      this.accessory.removeService(motion);
    }

    // An earlier version exposed the raw PIR on/off data point as an unnamed switch.
    const oldSwitch = this.accessory.getService('switch_pir');
    if (oldSwitch) {
      this.accessory.removeService(oldSwitch);
    }

    this.configureAutoSwitch();
  }

  configureAutoSwitch() {
    const service = this.accessory.getService('auto')
      || this.accessory.addService(this.Service.Switch, 'auto', 'auto');
    configureName(this, service, 'Auto (radar)');
    this.autoService = service;

    service.getCharacteristic(this.Characteristic.On)
      .onGet(() => {
        this.checkOnlineStatus();
        return this.getStatus(SCHEMA_CODE.MODE[0])?.value === 'auto';
      })
      .onSet(async value => {
        const mode = value ? 'auto' : 'manual';
        if (this.getStatus(SCHEMA_CODE.MODE[0])?.value === mode) {
          return; // HomeKit often sends the same command twice
        }
        await this.sendCommands([{ code: SCHEMA_CODE.MODE[0], value: mode }]);
      });
  }

  async onDeviceStatusUpdate(status: TuyaDeviceStatus[]) {
    // While the slider is being dragged the lamp answers every step with a delay, and the late answers
    // would move the slider back. Keep the value that was sent last for a moment.
    const now = Date.now();
    for (const item of status) {
      const sent = this.sent.get(item.code);
      if (sent && now - sent.at < ECHO_WINDOW_MS && item.value !== sent.value) {
        const cached = this.device.status.find(entry => entry.code === item.code);
        if (cached) {
          cached.value = sent.value;
        }
      }
    }
    return super.onDeviceStatusUpdate(status);
  }

  async sendCommands(commands: TuyaDeviceStatus[], debounce?: boolean) {
    for (const command of commands) {
      if (SLIDER_CODES.includes(command.code)) {
        this.sent.set(command.code, { value: command.value, at: Date.now() });
      }
    }

    const forced = withManualMode(commands, this.getStatus(SCHEMA_CODE.MODE[0])?.value);
    if (forced === commands) {
      return super.sendCommands(commands, debounce);
    }

    // The lamp applies data points in numeric order, so a mode change sent together with the light
    // would land last and reset it. Switch to manual first, let it settle, then send the light.
    await super.sendCommands([forced[0]], false);
    this.autoService?.getCharacteristic(this.Characteristic.On).updateValue(false);
    await new Promise(resolve => setTimeout(resolve, MODE_SETTLE_MS));
    return super.sendCommands(commands, debounce);
  }

}
