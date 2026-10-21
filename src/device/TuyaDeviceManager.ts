import EventEmitter from 'events';
import TuyaOpenAPI from '../core/TuyaOpenAPI';
import TuyaOpenMQ from '../core/TuyaOpenMQ';
import { TuyaLocalClientFactory } from '../core/TuyaLocal';
import { TuyaPlatformLocalDeviceConfig } from '../config';
import Logger, { PrefixLogger } from '../util/Logger';
import TuyaLocalLink from './TuyaLocalLink';
import { parseThingModel } from './ThingModel';
import TuyaDevice, {
  TuyaDeviceSchema,
  TuyaDeviceSchemaMode,
  TuyaDeviceSchemaProperty,
  TuyaDeviceStatus,
} from './TuyaDevice';

enum Events {
  DEVICE_ADD = 'DEVICE_ADD',
  DEVICE_INFO_UPDATE = 'DEVICE_INFO_UPDATE',
  DEVICE_STATUS_UPDATE = 'DEVICE_STATUS_UPDATE',
  DEVICE_DELETE = 'DEVICE_DELETE',
  DEVICE_LOCAL_UPDATE = 'DEVICE_LOCAL_UPDATE', // local ip / protocol version learned
}

enum TuyaMQTTProtocol {
  DEVICE_STATUS_UPDATE = 4,
  DEVICE_INFO_UPDATE = 20,
}

export default class TuyaDeviceManager extends EventEmitter {

  static readonly Events = Events;

  public mq: TuyaOpenMQ;
  public ownerIDs: string[] = [];
  public devices: TuyaDevice[] = [];
  public log: Logger;

  // false when running without the Tuya cloud (local-only mode)
  public cloud = true;
  public local?: TuyaLocalLink;

  constructor(
    public api: TuyaOpenAPI,
    public debug = false,
  ) {
    super();

    const log = (this.api.log as PrefixLogger).log;
    this.log = new PrefixLogger(log, TuyaDeviceManager.name, debug);

    this.mq = new TuyaOpenMQ(api, log);
    this.mq.addMessageListener(this.onMQTTMessage.bind(this));
  }

  /**
   * Start LAN control for devices that have a local key (from the cloud, the snapshot or `localDevices`).
   * Commands then go over LAN first and status is pushed by the device itself.
   */
  enableLocal(
    devices: TuyaDevice[],
    options: { exclude?: string[]; localDevices?: TuyaPlatformLocalDeviceConfig[] } = {},
    clientFactory?: TuyaLocalClientFactory,
  ) {
    const link = this.local ?? new TuyaLocalLink(this.log, clientFactory);
    if (!this.local) {
      this.local = link;
      link.on('status', (deviceID: string, status: TuyaDeviceStatus[]) => this.applyStatusUpdate(deviceID, status));
      link.on('online', (deviceID: string, online: boolean) => this.onLocalOnline(deviceID, online));
      link.on('version', (deviceID: string, version: string) => this.onLocalInfo(deviceID, { version }));
      link.on('ip', (deviceID: string, ip: string) => this.onLocalInfo(deviceID, { ip }));
    }

    for (const device of devices) {
      const config = options.localDevices?.find(item => item.id === device.id);
      const excluded = (options.exclude ?? []).some(id => id === device.id || id === device.product_id);
      const key = config?.key ?? device.local_key;
      if (excluded || !key || device.sub || device.parent_id || device.category === 'scene') {
        continue;
      }

      const ip = config?.ip ?? device.local?.ip;
      const version = config?.version ?? device.local?.version;
      link.register(device, { key, ip, version });
      this.log.info('Local control enabled for %s (%s)', device.name, ip ?? 'auto-discover');
    }

    link.start();
  }

  onLocalOnline(deviceID: string, online: boolean) {
    const device = this.getDevice(deviceID);
    if (!device) {
      return;
    }
    this.log.debug('Local connection %s: %s', online ? 'up' : 'down', device.name);

    // With the cloud present, its online flag stays authoritative.
    if (this.cloud || device.online === online) {
      return;
    }
    device.online = online;
    this.emit(Events.DEVICE_INFO_UPDATE, device, { bizCode: online ? 'online' : 'offline' });
  }

  onLocalInfo(deviceID: string, info: { ip?: string; version?: string }) {
    const device = this.getDevice(deviceID);
    if (!device) {
      return;
    }
    device.local = { ...device.local, ...info };
    this.emit(Events.DEVICE_LOCAL_UPDATE, device);
  }

  applyStatusUpdate(deviceID: string, status: TuyaDeviceStatus[]) {
    const device = this.getDevice(deviceID);
    if (!device) {
      return;
    }

    for (const item of device.status) {
      const _item = status.find(_item => _item.code === item.code);
      if (!_item) {
        continue;
      }
      item.value = _item.value;
    }

    this.emit(Events.DEVICE_STATUS_UPDATE, device, status);
  }

  getDevice(deviceID: string) {
    return Array.from(this.devices).find(device => device.id === deviceID);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async updateDevices(ownerIDs: []): Promise<TuyaDevice[]> {
    return [];
  }

  async updateDevice(deviceID: string) {

    const res = await this.getDeviceInfo(deviceID);
    if (!res.success) {
      return null;
    }

    const device = new TuyaDevice(res.result);
    await this.loadDeviceSchema(device);

    const oldDevice = this.getDevice(deviceID);
    if (oldDevice) {
      this.devices.splice(this.devices.indexOf(oldDevice), 1);
    }

    this.devices.push(device);

    return device;
  }

  async getDeviceInfo(deviceID: string) {
    const res = await this.api.get(`/v1.0/devices/${deviceID}`);
    return res;
  }

  async getDeviceListInfo(deviceIDs: string[] = []) {
    const res = await this.api.get('/v1.0/devices', { 'device_ids': deviceIDs.join(',') });
    return res;
  }

  async getDeviceSchema(deviceID: string) {
    // const res = await this.api.get(`/v1.2/iot-03/devices/${deviceID}/specification`);
    const res = await this.api.get(`/v1.0/devices/${deviceID}/specifications`);
    if (res.success === false) {
      this.log.warn('Get device specification failed. devId = %s, code = %s, msg = %s', deviceID, res.code, res.msg);
      return [];
    }

    // Combine functions and status together, as it used to be.
    const schemas = new Map<string, TuyaDeviceSchema>();
    for (const { code, type, values, dp_id } of [...res.result.status, ...res.result.functions]) {
      if (schemas[code]) {
        continue;
      }

      const read = (res.result.status).find(schema => schema.code === code) !== undefined;
      const write = (res.result.functions).find(schema => schema.code === code) !== undefined;
      let mode = TuyaDeviceSchemaMode.UNKNOWN;
      if (read && write) {
        mode = TuyaDeviceSchemaMode.READ_WRITE;
      } else if (read && !write) {
        mode = TuyaDeviceSchemaMode.READ_ONLY;
      } else if (!read && write) {
        mode = TuyaDeviceSchemaMode.WRITE_ONLY;
      }
      let property: TuyaDeviceSchemaProperty;
      try {
        property = JSON.parse(values);
        schemas[code] = { code, mode, type, property };
        if (typeof dp_id === 'number') {
          schemas[code].dp_id = dp_id;
        }
      } catch (error) {
        // ignore infrared remote's invalid schema because it's not used.
      }
    }

    const result = Object.values(schemas).sort((a, b) => a.code > b.code ? 1 : -1) as TuyaDeviceSchema[];
    await this.fillDpIds(deviceID, result);
    return result;
  }

  /**
   * The local (LAN) protocol addresses data points by id, the cloud model by code.
   * Fill in `dp_id` from the Things Data Model when the specification did not carry it.
   */
  async fillDpIds(deviceID: string, schemas: TuyaDeviceSchema[]) {
    if (schemas.length === 0 || schemas.every(schema => schema.dp_id !== undefined)) {
      return;
    }

    try {
      const res = await this.api.get(`/v2.0/cloud/thing/${deviceID}/shadow/properties`);
      if (res.success === false) {
        this.log.debug('Get dp ids failed. devId = %s, code = %s, msg = %s', deviceID, res.code, res.msg);
        return;
      }
      for (const { code, dp_id } of (res.result?.properties ?? []) as Array<{ code: string; dp_id: number }>) {
        const schema = schemas.find(item => item.code === code);
        if (schema && typeof dp_id === 'number') {
          schema.dp_id = dp_id;
        }
      }
    } catch (error) {
      this.log.debug('Get dp ids failed. devId = %s, error = %s', deviceID, (error as Error)?.message);
    }

    const missing = schemas.filter(schema => schema.dp_id === undefined).map(schema => schema.code);
    if (missing.length > 0) {
      this.log.debug('No dp_id for %o of devId = %s, those stay cloud-only.', missing, deviceID);
    }
  }

  /** Standard specification first, Things Data Model for products without a standard instruction set. */
  async loadDeviceSchema(device: TuyaDevice) {
    device.schema = await this.getDeviceSchema(device.id);
    if (device.schema.length === 0 && !device.sub && !device.isIRControlHub()) {
      await this.loadThingModel(device);
    }
  }

  async loadThingModel(device: TuyaDevice) {
    const res = await this.api.get(`/v2.0/cloud/thing/${device.id}/model`);
    if (res.success === false) {
      this.log.warn('Get thing model failed. devId = %s, code = %s, msg = %s', device.id, res.code, res.msg);
      return;
    }

    let schema: TuyaDeviceSchema[];
    try {
      schema = parseThingModel(res.result);
    } catch (error) {
      this.log.warn('Parse thing model failed. devId = %s, error = %s', device.id, (error as Error)?.message);
      return;
    }
    if (schema.length === 0) {
      this.log.warn('Thing model of devId = %s has no usable properties.', device.id);
      return;
    }
    device.schema = schema;

    const shadow = await this.api.get(`/v2.0/cloud/thing/${device.id}/shadow/properties`);
    if (shadow.success === false) {
      this.log.warn('Get thing properties failed. devId = %s, code = %s, msg = %s', device.id, shadow.code, shadow.msg);
    }
    const known = new Set(device.status.map(item => item.code));
    for (const { code, value } of (shadow.result?.properties ?? []) as Array<{ code: string; value: unknown }>) {
      if (value !== undefined && !known.has(code) && schema.some(item => item.code === code)) {
        device.status.push({ code, value } as TuyaDeviceStatus);
      }
    }
    device.status.sort((a, b) => a.code > b.code ? 1 : -1);

    // Shown so `deviceOverrides` (category, code -> newCode) can be written for such a device.
    this.log.info(
      '%s (category %s, product %s) has no standard specification, using its thing model: %s',
      device.name, device.category, device.product_id,
      schema.map(item => `${item.code}(dp ${item.dp_id}, ${item.type}, ${item.mode})`).join(', '),
    );
  }

  async getInfraredRemotes(infraredID: string) {
    const res = await this.api.get(`/v2.0/infrareds/${infraredID}/remotes`);
    return res;
  }

  async getInfraredKeys(infraredID: string, remoteID: string) {
    const res = await this.api.get(`/v2.0/infrareds/${infraredID}/remotes/${remoteID}/keys`);
    return res;
  }

  async getInfraredACStatus(infraredID: string, remoteID: string) {
    const res = await this.api.get(`/v2.0/infrareds/${infraredID}/remotes/${remoteID}/ac/status`);
    return res;
  }

  async getInfraredDIYKeys(infraredID: string, remoteID: string) {
    const res = await this.api.get(`/v2.0/infrareds/${infraredID}/remotes/${remoteID}/learning-codes`);
    return res;
  }

  async updateInfraredRemotes(allDevices: TuyaDevice[]) {

    const irDevices = allDevices.filter(device => device.isIRControlHub());
    for (const irDevice of irDevices) {
      const res = await this.getInfraredRemotes(irDevice.id);
      if (!res.success) {
        this.log.warn('Get infrared remotes failed. deviceId = %d, code = %s, msg = %s', irDevice.id, res.code, res.msg);
        continue;
      }

      for (const { category_id, remote_id } of res.result) {
        const subDevice = allDevices.find(device => device.id === remote_id);
        if (!subDevice) {
          continue;
        }
        subDevice.parent_id = irDevice.id;
        subDevice.schema = [];
        const res = await this.getInfraredKeys(irDevice.id, subDevice.id);
        if (!res.success) {
          this.log.warn('Get infrared remote keys failed. deviceId = %d, code = %s, msg = %s', subDevice.id, res.code, res.msg);
          continue;
        }
        subDevice.remote_keys = res.result;

        if (subDevice.category === 'infrared_ac') { // AC Device
          const res = await this.getInfraredACStatus(irDevice.id, subDevice.id);
          if (!res.success) {
            this.log.warn('Get infrared ac status failed. deviceId = %d, code = %s, msg = %s', subDevice.id, res.code, res.msg);
            continue;
          }
          subDevice.status = Object.entries(res.result).map(([key, value]) => ({code: key, value} as TuyaDeviceStatus));
        } else if (category_id === 999) { // DIY Device
          const res = await this.getInfraredDIYKeys(irDevice.id, subDevice.id);
          if (!res.success) {
            this.log.warn('Get infrared diy keys failed. deviceId = %d, code = %s, msg = %s', subDevice.id, res.code, res.msg);
            continue;
          }
          const key_list = subDevice.remote_keys?.key_list || [];
          for (const key of key_list) {
            const item = (res.result as []).find(item => item['id'] === key.key_id && item['key'] === key.key);
            if (!item) {
              continue;
            }
            this.log.debug('learning_code:', item['code']);
            key.learning_code = item['code'];
          }
        }
      }
    }
  }

  async sendInfraredCommands(infraredID: string, remoteID: string, category_id: number, remote_index: number, key: string, key_id: number) {
    const res = await this.api.post(`/v2.0/infrareds/${infraredID}/remotes/${remoteID}/raw/command`, {
      category_id, remote_index, key, key_id,
    });
    return res;
  }

  async sendInfraredACCommands(infraredID: string, remoteID: string, power: number, mode: number, temp: number, wind: number) {
    const commands = (power === 1) ? { power, mode, temp, wind } : { power };
    const res = await this.api.post(`/v2.0/infrareds/${infraredID}/air-conditioners/${remoteID}/scenes/command`, commands);
    if (!res.success) {
      this.log.info('Send AC command failed. code = %d, msg = %s', res.code, res.msg);
    }
    return res;
  }

  async sendInfraredDIYCommands(infraredID: string, remoteID: string, code: string) {
    const res = await this.api.post(`/v2.0/infrareds/${infraredID}/remotes/${remoteID}/learning-codes`, { code });
    return res;
  }


  async getLockTemporaryKey(deviceID: string) {
    // const res = await this.api.post(`/v1.0/smart-lock/devices/${deviceID}/door-lock/password-ticket`);
    const res = await this.api.post(`/v1.0/smart-lock/devices/${deviceID}/password-ticket`);
    if (res.success === false) {
      this.log.warn('Get Temporary Pass failed. devID = %s, code = %s, msg = %s', deviceID, res.code, res.msg);
    }
    return res;
  }

  async sendLockCommands(deviceID: string, ticketID: string, open: boolean) {
    const res = await this.api.post(`/v1.0/smart-lock/devices/${deviceID}/password-free/door-operate`, {
      device_id: deviceID,
      ticket_id: ticketID,
      open,
    });
    return res;
  }


  async sendCommands(deviceID: string, commands: TuyaDeviceStatus[]) {
    const device = this.getDevice(deviceID);
    if (this.local && device && this.local.has(deviceID) && await this.local.send(device, commands)) {
      return true;
    }

    if (!this.cloud) {
      throw new Error(`Cannot reach ${device?.name ?? deviceID} over LAN and the Tuya cloud is not used.`);
    }

    const res = await this.api.post(`/v1.0/devices/${deviceID}/commands`, { commands });
    return res.result;
  }


  async onMQTTMessage(topic: string, protocol: TuyaMQTTProtocol, message) {
    switch(protocol) {
      case TuyaMQTTProtocol.DEVICE_STATUS_UPDATE: {
        const { devId, status } = message;
        this.applyStatusUpdate(devId, status);
        break;
      }
      case TuyaMQTTProtocol.DEVICE_INFO_UPDATE: {
        const { bizCode, bizData, devId } = message;
        if (bizCode === 'bindUser') {
          const { ownerId } = bizData;
          if (!this.ownerIDs.includes(ownerId)) {
            this.log.warn('Update devId = %s not included in your ownerIDs. Skip.', devId);
            return;
          }

          // TODO failed if request to quickly
          await new Promise(resolve => setTimeout(resolve, 10000));

          const device = await this.updateDevice(devId);
          if (!device) {
            return;
          }
          this.mq.start(); // Force reconnect, unless new device status update won't get received
          this.emit(Events.DEVICE_ADD, device);
        } else if (bizCode === 'nameUpdate') {
          const { name } = bizData;
          const device = this.getDevice(devId);
          if (!device) {
            return;
          }
          device.name = name;
          this.emit(Events.DEVICE_INFO_UPDATE, device, bizData);
        } else if (bizCode === 'online' || bizCode === 'offline') {
          const device = this.getDevice(devId);
          if (!device) {
            return;
          }
          device.online = (bizCode === 'online') ? true : false;
          this.emit(Events.DEVICE_INFO_UPDATE, device, bizData);
        } else if (bizCode === 'delete') {
          const { ownerId } = bizData;
          if (!this.ownerIDs.includes(ownerId)) {
            this.log.warn('Remove devId = %s not included in your ownerIDs. Skip.', devId);
            return;
          }

          const device = this.getDevice(devId);
          if (!device) {
            return;
          }
          this.devices.splice(this.devices.indexOf(device), 1);
          this.emit(Events.DEVICE_DELETE, devId);
        } else if (bizCode === 'event_notify') {
          // doorbell event
        } else if (bizCode === 'p2pSignal') {
          // p2p signal
        } else {
          this.log.warn('Unhandled mqtt message: bizCode = %s, bizData = %o', bizCode, bizData);
        }
        break;
      }
      default:
        this.log.warn('Unhandled mqtt message: protocol = %s, message = %o', protocol, message);
        break;
    }
  }

}
