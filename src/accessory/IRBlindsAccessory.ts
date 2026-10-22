import TuyaDevice, { TuyaIRRemoteKeyListItem } from '../device/TuyaDevice';
import BaseAccessory from './BaseAccessory';
import { configureName } from './characteristic/Name';

const KEY_NAMES = {
  OPEN: ['power_on', 'open'],
  CLOSE: ['power_off', 'close'],
  STOP: ['stop'],
};

// RF categories of blinds / curtains / windows (Tuya "RF" category ids).
const RF_BLINDS_CATEGORY_IDS = [1, 9, 10, 11];

/**
 * Blinds, curtains and shutters on a learned remote (RF or IR) that only know open / close / stop.
 * Nothing reports the position back, so the window covering has just two positions (0 and 100, no
 * slider steps in between), an assumed state, and a separate Stop button.
 */
export default class IRBlindsAccessory extends BaseAccessory {

  static findKey(device: TuyaDevice, names: string[]) {
    return device.remote_keys?.key_list.find(key => names.includes(key.key));
  }

  static supports(device: TuyaDevice) {
    return device.isRFRemoteControl()
      && RF_BLINDS_CATEGORY_IDS.includes(device.remote_keys!.category_id)
      && !!this.findKey(device, KEY_NAMES.OPEN)
      && !!this.findKey(device, KEY_NAMES.CLOSE);
  }

  requiredSchema() {
    return [];
  }

  configureServices() {
    // Earlier versions exposed open / close as separate switches.
    for (const subtype of ['open', 'close']) {
      const old = this.accessory.getServiceById(this.Service.Switch, subtype);
      if (old) {
        this.accessory.removeService(old);
      }
    }

    const open = IRBlindsAccessory.findKey(this.device, KEY_NAMES.OPEN)!;
    const close = IRBlindsAccessory.findKey(this.device, KEY_NAMES.CLOSE)!;
    const stop = IRBlindsAccessory.findKey(this.device, KEY_NAMES.STOP);

    const { CurrentPosition, TargetPosition, PositionState } = this.Characteristic;
    const service = this.accessory.getService(this.Service.WindowCovering)
      || this.accessory.addService(this.Service.WindowCovering);
    configureName(this, service, this.device.name);

    const props = { minValue: 0, maxValue: 100, minStep: 100 };
    let position: number = (this.accessory.context.position ?? 0) >= 50 ? 100 : 0;

    service.getCharacteristic(CurrentPosition).setProps(props).onGet(() => position);
    service.getCharacteristic(PositionState).onGet(() => PositionState.STOPPED);
    service.getCharacteristic(TargetPosition).setProps(props)
      .onGet(() => position)
      .onSet(async value => {
        const target = (value as number) >= 50 ? 100 : 0;
        await this.sendKey(target === 100 ? open : close);
        position = target;
        this.accessory.context.position = position;
        service.getCharacteristic(CurrentPosition).updateValue(position);
        service.getCharacteristic(PositionState).updateValue(PositionState.STOPPED);
      });

    if (stop) {
      this.configureStopButton(stop);
    }
  }

  configureStopButton(key: TuyaIRRemoteKeyListItem) {
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
