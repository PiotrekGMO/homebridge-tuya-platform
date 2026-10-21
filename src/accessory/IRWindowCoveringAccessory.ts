import TuyaDevice, { TuyaIRRemoteKeyListItem } from '../device/TuyaDevice';
import BaseAccessory from './BaseAccessory';
import { configureName } from './characteristic/Name';

const KEY_NAMES = {
  OPEN: ['power_on', 'open'],
  CLOSE: ['power_off', 'close'],
  STOP: ['stop'],
};

// RF categories of blinds / curtains / windows (Tuya "RF" category ids).
const RF_COVERING_CATEGORY_IDS = [1, 9, 10, 11];

/**
 * Blinds, curtains and shutters controlled through a learned remote (RF or IR) with only
 * open / close / stop keys. There is no position feedback, so the position HomeKit shows is
 * assumed: 100 sends "open", 0 sends "close", anything in between sends "stop".
 */
export default class IRWindowCoveringAccessory extends BaseAccessory {

  static findKey(device: TuyaDevice, names: string[]) {
    return device.remote_keys?.key_list.find(key => names.includes(key.key));
  }

  static supports(device: TuyaDevice) {
    return device.isRFRemoteControl()
      && RF_COVERING_CATEGORY_IDS.includes(device.remote_keys!.category_id)
      && !!this.findKey(device, KEY_NAMES.OPEN)
      && !!this.findKey(device, KEY_NAMES.CLOSE);
  }

  requiredSchema() {
    return [];
  }

  configureServices() {
    const open = IRWindowCoveringAccessory.findKey(this.device, KEY_NAMES.OPEN)!;
    const close = IRWindowCoveringAccessory.findKey(this.device, KEY_NAMES.CLOSE)!;
    const stop = IRWindowCoveringAccessory.findKey(this.device, KEY_NAMES.STOP);

    const { CurrentPosition, TargetPosition, PositionState } = this.Characteristic;
    const service = this.accessory.getService(this.Service.WindowCovering)
      || this.accessory.addService(this.Service.WindowCovering);
    configureName(this, service, this.device.name);

    let position: number = this.accessory.context.position ?? 0;

    service.getCharacteristic(CurrentPosition).onGet(() => position);
    service.getCharacteristic(PositionState).onGet(() => PositionState.STOPPED);
    service.getCharacteristic(TargetPosition)
      .onGet(() => position)
      .onSet(async value => {
        const target = value as number;
        const key = (target >= 100) ? open : (target <= 0) ? close : stop;
        if (!key) {
          return;
        }

        await this.sendKey(key);
        position = target;
        this.accessory.context.position = position;
        service.getCharacteristic(CurrentPosition).updateValue(position);
        service.getCharacteristic(PositionState).updateValue(PositionState.STOPPED);
      });

    if (stop) {
      this.configureStopSwitch(stop);
    }
  }

  configureStopSwitch(key: TuyaIRRemoteKeyListItem) {
    const service = this.accessory.getService('stop')
      || this.accessory.addService(this.Service.Switch, 'stop', 'stop');
    configureName(this, service, 'Stop');

    service.getCharacteristic(this.Characteristic.On)
      .onGet(() => false)
      .onSet(async value => {
        if (value === false) {
          return;
        }
        try {
          await this.sendKey(key);
        } finally {
          setTimeout(() => service.getCharacteristic(this.Characteristic.On).updateValue(false), 150);
        }
      });
  }

  async sendKey(key: TuyaIRRemoteKeyListItem) {
    const res = await this.deviceManager.sendInfraredKey(this.device, key);
    if (res && res.success === false) {
      this.log.warn('Sending key "%s" failed. code = %s, msg = %s', key.key, res.code, res.msg);
      const { HapStatusError, HAPStatus } = this.platform.api.hap;
      throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

}
