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

const MODE_SETTLE_MS = 400;
const FLIP_WAIT_MS = 1500;

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
  private holdOn?: boolean; // light state to keep while the mode changes
  private flipSeen = false;

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
        const mode = value ? 'auto' : 'manual';
        if (this.getStatus(SCHEMA_CODE.MODE[0])?.value === mode) {
          return; // HomeKit often sends the same command twice
        }
        await this.changeMode(mode);
      });
  }

  /**
   * The lamp itself turns its light on when it goes to manual and off when it goes to auto. Switching
   * the mode must not touch the light, so the light state from before is remembered, the lamp's own
   * change is kept away from HomeKit, and the previous state is sent back.
   */
  private async changeMode(mode: 'auto' | 'manual') {
    const on = this.getStatus(SCHEMA_CODE.ON[0])?.value;
    this.holdOn = typeof on === 'boolean' ? on : undefined;
    this.flipSeen = false;

    try {
      await super.sendCommands([{ code: SCHEMA_CODE.MODE[0], value: mode }], false);
      if (this.holdOn !== undefined) {
        const deadline = Date.now() + FLIP_WAIT_MS;
        while (!this.flipSeen && Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        if (this.flipSeen) {
          await super.sendCommands([{ code: SCHEMA_CODE.ON[0], value: this.holdOn }], false);
          await new Promise(resolve => setTimeout(resolve, MODE_SETTLE_MS)); // let the echo pass
        }
      }
    } finally {
      this.holdOn = undefined;
    }
  }

  async onDeviceStatusUpdate(status: TuyaDeviceStatus[]) {
    if (this.holdOn !== undefined && status.some(item => item.code === SCHEMA_CODE.ON[0] && item.value !== this.holdOn)) {
      this.flipSeen = true;
      const cached = this.device.status.find(item => item.code === SCHEMA_CODE.ON[0]);
      if (cached) {
        cached.value = this.holdOn; // the lamp's reflex, not a real change of the light
      }
    }
    return super.onDeviceStatusUpdate(status);
  }

  async sendCommands(commands: TuyaDeviceStatus[], debounce?: boolean) {
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
