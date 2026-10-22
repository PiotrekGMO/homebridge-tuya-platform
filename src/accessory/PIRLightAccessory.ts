import TuyaDevice, { TuyaDeviceSchemaEnumProperty, TuyaDeviceSchemaType, TuyaDeviceStatus } from '../device/TuyaDevice';
import LightAccessory from './LightAccessory';
import { configureLight } from './characteristic/Light';
import { configureMotionDetected } from './characteristic/MotionDetected';
import { configureName } from './characteristic/Name';

const SCHEMA_CODE = {
  ON: ['switch_led'],
  BRIGHTNESS: ['bright_value', 'bright_value_v2'],
  COLOR_TEMP: ['temp_value', 'temp_value_v2'],
  COLOR: ['colour_data', 'colour_data_v2'],
  WORK_MODE: ['work_mode'],
  PIR: ['pir_state'],
  MODE: ['device_mode'],
};

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

export default class PIRLightAccessory extends LightAccessory {

  private autoService?;

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

    configureMotionDetected(this, undefined, this.getSchema(...SCHEMA_CODE.PIR));

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
        await this.sendCommands([{ code: SCHEMA_CODE.MODE[0], value: value ? 'auto' : 'manual' }]);
      });
  }

  async sendCommands(commands: TuyaDeviceStatus[], debounce?: boolean) {
    const forced = withManualMode(commands, this.getStatus(SCHEMA_CODE.MODE[0])?.value);
    await super.sendCommands(forced, debounce);

    if (forced !== commands) {
      this.autoService?.getCharacteristic(this.Characteristic.On).updateValue(false);
    }
  }

}
