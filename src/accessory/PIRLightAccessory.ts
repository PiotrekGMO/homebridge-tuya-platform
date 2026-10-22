import { debounce } from 'debounce';
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
const MODE_ECHO_MS = 2500;

// Values of the manual mode. The slider shows these, and they are what the lamp gets back when it
// leaves the automatic mode, whatever the lamp itself reports while the motion sensor is in charge.
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
 * HomeKit shows. Brightness and colour temperature always show the manual mode's values, which are
 * remembered (also over a restart) and given back to the lamp when it returns to manual.
 */
export default class PIRLightAccessory extends LightAccessory {

  private autoService?;
  private sent = new Map<string, { value: TuyaDeviceStatus['value']; at: number }>(); // last slider values sent
  private ignoreLampUntil = 0; // the lamp's own values right after a mode change are not the manual ones
  private saveContext = debounce(() => this.platform.api.updatePlatformAccessories([this.accessory]), 5000);

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

    this.initManualValues();

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
        if (mode === 'manual') {
          this.ignoreLampUntil = Date.now() + MODE_ECHO_MS;
          await new Promise(resolve => setTimeout(resolve, MODE_SETTLE_MS));
          await this.restoreManualValues([]);
        }
      });
  }

  // --- the values of the manual mode ---

  manualValues(): Record<string, number> {
    this.accessory.context.manual = this.accessory.context.manual ?? {};
    return this.accessory.context.manual;
  }

  remember(code: string, value: TuyaDeviceStatus['value']) {
    if (typeof value === 'number' && this.manualValues()[code] !== value) {
      this.manualValues()[code] = value;
      this.saveContext();
    }
  }

  private isAuto() {
    return this.getStatus(SCHEMA_CODE.MODE[0])?.value === 'auto';
  }

  /** The first start: what the lamp reports is the best guess, after that the remembered values rule. */
  initManualValues() {
    for (const status of this.device.status) {
      if (SLIDER_CODES.includes(status.code) && this.manualValues()[status.code] === undefined) {
        this.remember(status.code, status.value);
      }
    }
    this.showManualValues();
  }

  /** In the automatic mode the cache, and so HomeKit, keeps the manual values instead of the lamp's own. */
  showManualValues() {
    if (!this.isAuto()) {
      return;
    }
    for (const [code, value] of Object.entries(this.manualValues())) {
      const cached = this.device.status.find(item => item.code === code);
      if (cached) {
        cached.value = value;
      }
    }
  }

  /** Gives the manual values back to the lamp, except those the user is setting right now. */
  async restoreManualValues(userCommands: TuyaDeviceStatus[]) {
    const own = new Set(userCommands.map(command => command.code));
    const restore = Object.entries(this.manualValues())
      .filter(([code]) => !own.has(code) && this.device.schema.some(schema => schema.code === code))
      .map(([code, value]) => ({ code, value } as TuyaDeviceStatus));
    if (restore.length > 0) {
      await super.sendCommands(restore, false);
    }
  }

  // --- status and commands ---

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

    // What the lamp reports for brightness and colour temperature counts as the manual mode's value only
    // while the lamp is in the manual mode, and not right after a mode change.
    if (this.isAuto()) {
      this.showManualValues();
    } else if (now >= this.ignoreLampUntil) {
      for (const item of status) {
        if (SLIDER_CODES.includes(item.code)) {
          this.remember(item.code, this.device.status.find(entry => entry.code === item.code)?.value ?? item.value);
        }
      }
    } else {
      for (const [code, value] of Object.entries(this.manualValues())) {
        const cached = this.device.status.find(entry => entry.code === code);
        if (cached) {
          cached.value = value;
        }
      }
    }
    return super.onDeviceStatusUpdate(status);
  }

  async sendCommands(commands: TuyaDeviceStatus[], debounce?: boolean) {
    for (const command of commands) {
      if (SLIDER_CODES.includes(command.code)) {
        this.sent.set(command.code, { value: command.value, at: Date.now() });
        this.remember(command.code, command.value);
      }
    }

    const forced = withManualMode(commands, this.getStatus(SCHEMA_CODE.MODE[0])?.value);
    if (forced === commands) {
      return super.sendCommands(commands, debounce);
    }

    // The lamp applies data points in numeric order, so a mode change sent together with the light
    // would land last and reset it. Switch to manual first, let it settle, give the lamp its manual
    // values back, then send the light.
    this.ignoreLampUntil = Date.now() + MODE_ECHO_MS;
    await super.sendCommands([forced[0]], false);
    this.autoService?.getCharacteristic(this.Characteristic.On).updateValue(false);
    await new Promise(resolve => setTimeout(resolve, MODE_SETTLE_MS));
    await this.restoreManualValues(commands);
    return super.sendCommands(commands, debounce);
  }

}
