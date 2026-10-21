import TuyaDevice, { TuyaIRRemoteKeyListItem } from '../device/TuyaDevice';
import BaseAccessory from './BaseAccessory';
import { configureName } from './characteristic/Name';

const KEYS = [
  { subtype: 'open', name: 'Open', keys: ['power_on', 'open'] },
  { subtype: 'close', name: 'Close', keys: ['power_off', 'close'] },
  { subtype: 'stop', name: 'Stop', keys: ['stop'] },
];

// RF categories of blinds / curtains / windows (Tuya "RF" category ids).
const RF_BLINDS_CATEGORY_IDS = [1, 9, 10, 11];

/**
 * Blinds, curtains and shutters on a learned remote (RF or IR) that only know open / close / stop.
 * Nothing reports the position back, so instead of a window covering with a made-up percentage
 * slider they show up as one momentary button per learned key.
 */
export default class IRBlindsAccessory extends BaseAccessory {

  static findKey(device: TuyaDevice, names: string[]) {
    return device.remote_keys?.key_list.find(key => names.includes(key.key));
  }

  static supports(device: TuyaDevice) {
    return device.isRFRemoteControl()
      && RF_BLINDS_CATEGORY_IDS.includes(device.remote_keys!.category_id)
      && !!this.findKey(device, KEYS[0].keys)
      && !!this.findKey(device, KEYS[1].keys);
  }

  requiredSchema() {
    return [];
  }

  configureServices() {
    // An earlier version exposed a window covering with a position slider.
    const covering = this.accessory.getService(this.Service.WindowCovering);
    if (covering) {
      this.accessory.removeService(covering);
    }

    for (const { subtype, name, keys } of KEYS) {
      const key = IRBlindsAccessory.findKey(this.device, keys);
      if (key) {
        this.configureButton(subtype, name, key);
      }
    }
  }

  configureButton(subtype: string, name: string, key: TuyaIRRemoteKeyListItem) {
    const service = this.accessory.getService(subtype)
      || this.accessory.addService(this.Service.Switch, subtype, subtype);
    configureName(this, service, name);

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
