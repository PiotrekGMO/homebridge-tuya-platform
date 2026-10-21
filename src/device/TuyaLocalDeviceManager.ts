import { TuyaPlatformLocalDeviceConfig } from '../config';
import TuyaOpenAPI from '../core/TuyaOpenAPI';
import Logger from '../util/Logger';
import TuyaDevice, { TuyaDeviceSchema, TuyaDeviceSchemaMode, TuyaDeviceSchemaType, TuyaDeviceStatus } from './TuyaDevice';
import TuyaDeviceManager from './TuyaDeviceManager';
import { defaultStatusValue } from './TuyaLocalLink';

/**
 * Device manager that never talks to the Tuya cloud. Devices come from the local snapshot
 * (written during an earlier cloud sync) and/or the `localDevices` config entries.
 */
export default class TuyaLocalDeviceManager extends TuyaDeviceManager {

  constructor(log: Logger, debug = false) {
    // The API object is never used (no login, no MQTT), it only satisfies the base class.
    super(new TuyaOpenAPI('http://127.0.0.1', '', '', log, 'en', debug), debug);
    this.cloud = false;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async updateDevices(snapshot: TuyaDevice[], localDevices: TuyaPlatformLocalDeviceConfig[] = []) {
    const devices = new Map<string, TuyaDevice>();
    for (const device of snapshot) {
      devices.set(device.id, device);
    }
    for (const config of localDevices) {
      devices.set(config.id, this.mergeConfig(devices.get(config.id), config));
    }

    for (const device of devices.values()) {
      device.online = false; // until the LAN connection is up
      this.fillMissingStatus(device);
    }

    this.devices = [...devices.values()];
    return this.devices;
  }

  // Infrared hubs, sub-devices and scenes need the cloud.
  async updateInfraredRemotes() {
    return;
  }

  private mergeConfig(base: TuyaDevice | undefined, config: TuyaPlatformLocalDeviceConfig) {
    const schema: TuyaDeviceSchema[] = config.schema
      ? config.schema.map(item => ({
        code: item.code,
        dp_id: item.dp_id,
        mode: (item.mode as TuyaDeviceSchemaMode) ?? TuyaDeviceSchemaMode.READ_WRITE,
        type: item.type ?? TuyaDeviceSchemaType.Boolean,
        property: item.property ?? {},
      } as TuyaDeviceSchema))
      : base?.schema ?? [];

    return new TuyaDevice({
      uuid: config.id,
      owner_id: 'local',
      product_name: '',
      icon: '',
      sub: false,
      ...base,
      id: config.id,
      name: config.name ?? base?.name ?? config.id,
      category: config.category ?? base?.category ?? 'hidden',
      product_id: config.product_id ?? base?.product_id ?? 'local',
      local_key: config.key ?? base?.local_key,
      local: { ...base?.local, ip: config.ip ?? base?.local?.ip, version: config.version ?? base?.local?.version },
      schema,
      status: base?.status ?? [],
    });
  }

  /** Accessories are built from `status`, so give every readable schema entry a value up front. */
  private fillMissingStatus(device: TuyaDevice) {
    for (const schema of device.schema) {
      if (schema.mode === TuyaDeviceSchemaMode.WRITE_ONLY || device.status.some(item => item.code === schema.code)) {
        continue;
      }
      device.status.push({ code: schema.code, value: defaultStatusValue(schema) } as TuyaDeviceStatus);
    }
    device.status.sort((a, b) => a.code > b.code ? 1 : -1);
  }

}
