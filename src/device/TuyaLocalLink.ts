import EventEmitter from 'events';
import TuyaLocalConnection, { TuyaLocalClientFactory, TuyaLocalDps } from '../core/TuyaLocal';
import Logger from '../util/Logger';
import TuyaDevice, { TuyaDeviceSchema, TuyaDeviceSchemaType, TuyaDeviceStatus } from './TuyaDevice';
import { decodeLocalValue, encodeLocalValue } from './TuyaLocalValues';

export interface TuyaLocalRegistration {
  key: string;
  ip?: string;
  version?: string;
  // false: connect only for the moment of a write (IR/RF hubs, which allow a single connection)
  persistent?: boolean;
  ipFixed?: boolean; // the address was configured by hand, never forget it
}

/**
 * Binds `TuyaDevice`s to LAN connections and translates between the code-based model used by
 * the accessories (`switch_1`) and the DP-id based local protocol (`1`).
 *
 * Events: 'status' (deviceID, TuyaDeviceStatus[]), 'online' (deviceID, boolean),
 *         'version' (deviceID, string), 'ip' (deviceID, string).
 */
export default class TuyaLocalLink extends EventEmitter {

  private entries = new Map<string, { device: TuyaDevice; connection: TuyaLocalConnection; persistent: boolean }>();

  constructor(
    private readonly log: Logger,
    private readonly factory?: TuyaLocalClientFactory,
  ) {
    super();
  }

  register(device: TuyaDevice, registration: TuyaLocalRegistration) {
    this.unregister(device.id);

    const connection = new TuyaLocalConnection({
      id: device.id,
      key: registration.key,
      ip: registration.ip,
      ipFixed: registration.ipFixed,
      version: registration.version,
    }, this.log, this.factory);

    connection.on('status', dps => this.onDps(device, dps));
    connection.on('connected', () => this.emit('online', device.id, true));
    connection.on('disconnected', () => this.emit('online', device.id, false));
    connection.on('version', version => this.emit('version', device.id, version));
    connection.on('ip', ip => this.emit('ip', device.id, ip));

    this.entries.set(device.id, { device, connection, persistent: registration.persistent !== false });
    return connection;
  }

  unregister(deviceID: string) {
    this.entries.get(deviceID)?.connection.stop();
    this.entries.delete(deviceID);
  }

  start() {
    this.entries.forEach(({ connection, persistent }) => persistent && connection.start());
  }

  stop() {
    this.entries.forEach(({ connection }) => connection.stop());
  }

  has(deviceID: string) {
    return this.entries.has(deviceID);
  }

  isConnected(deviceID: string) {
    return this.entries.get(deviceID)?.connection.connected === true;
  }

  /**
   * @returns true when all commands were sent over LAN, false when the caller should fall back.
   */
  async send(device: TuyaDevice, commands: TuyaDeviceStatus[]): Promise<boolean> {
    const entry = this.entries.get(device.id);
    if (!entry || !entry.connection.connected) {
      return false;
    }

    const dps = this.toDps(device, commands);
    if (!dps) {
      return false;
    }

    try {
      await entry.connection.setDps(dps);
      return true;
    } catch (error) {
      this.log.debug('Local send failed (%s): %s', device.name, (error as Error)?.message ?? error);
      return false;
    }
  }

  /** Raw write by data point id, for devices without a schema (e.g. the `ir_send` of an IR+RF hub). */
  async sendDps(deviceID: string, dps: Record<string, unknown>): Promise<boolean> {
    const entry = this.entries.get(deviceID);
    if (!entry) {
      return false;
    }
    if (!entry.persistent) {
      return entry.connection.sendOnce(dps);
    }
    if (!entry.connection.connected) {
      return false;
    }
    try {
      await entry.connection.setDps(dps);
      return true;
    } catch (error) {
      this.log.debug('Local send failed (%s): %s', deviceID, (error as Error)?.message ?? error);
      return false;
    }
  }

  toDps(device: TuyaDevice, commands: TuyaDeviceStatus[]): Record<string, unknown> | undefined {
    const dps: Record<string, unknown> = {};
    for (const { code, value } of commands) {
      const schema = device.schema.find(item => item.code === code);
      if (!schema || schema.dp_id === undefined) {
        this.log.debug('No dp_id for code %s of %s, cannot send locally.', code, device.name);
        return undefined;
      }
      dps[String(schema.dp_id)] = encodeLocalValue(schema, value);
    }
    return dps;
  }

  toStatus(device: TuyaDevice, dps: TuyaLocalDps): TuyaDeviceStatus[] {
    const status: TuyaDeviceStatus[] = [];
    for (const [dpId, value] of Object.entries(dps)) {
      const schema = device.schema.find(item => item.dp_id !== undefined && String(item.dp_id) === dpId);
      if (!schema) {
        this.log.debug('Unknown dp %s=%o for %s.', dpId, value, device.name);
        continue;
      }
      status.push({ code: schema.code, value: decodeLocalValue(schema, value) });
    }
    return status;
  }

  private onDps(device: TuyaDevice, dps: TuyaLocalDps) {
    const status = this.toStatus(device, dps);
    if (status.length > 0) {
      this.emit('status', device.id, status);
    }
  }

}

/** A plausible value for a schema entry, used before the first local status arrives. */
export function defaultStatusValue(schema: TuyaDeviceSchema): TuyaDeviceStatus['value'] {
  switch (schema.type) {
    case TuyaDeviceSchemaType.Boolean:
      return false;
    case TuyaDeviceSchemaType.Integer:
      return (schema.property as { min?: number })?.min ?? 0;
    case TuyaDeviceSchemaType.Enum:
      return (schema.property as { range?: string[] })?.range?.[0] ?? '';
    default:
      return '';
  }
}
