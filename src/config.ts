import { PlatformConfig } from 'homebridge';
import { TuyaDeviceSchemaProperty, TuyaDeviceSchemaType } from './device/TuyaDevice';
export interface TuyaPlatformDeviceSchemaConfig {
  code: string;
  newCode?: string;
  type?: TuyaDeviceSchemaType;
  property?: TuyaDeviceSchemaProperty;
  onGet?: string;
  onSet?: string;
  hidden?: boolean;
}

export interface TuyaPlatformDeviceConfig {
  id: string;
  category?: string;
  schema?: Array<TuyaPlatformDeviceSchemaConfig>;
  unbridged?: boolean;
  adaptiveLighting?: boolean;
}

export interface TuyaPlatformLocalConfig {
  enabled?: boolean; // control devices over LAN first; cloud (when available) is the fallback
  exclude?: Array<string>; // device ids / product ids that must stay cloud-only (e.g. battery devices)
}

export interface TuyaPlatformLocalDeviceConfig {
  id: string;
  name?: string;
  key?: string; // local key; taken from the cloud/snapshot when omitted
  ip?: string; // discovered over UDP when omitted
  version?: string; // probed when omitted: 3.1 | 3.3 | 3.4 | 3.5
  category?: string;
  product_id?: string;
  schema?: Array<{
    code: string;
    dp_id: number;
    type?: TuyaDeviceSchemaType;
    mode?: 'rw' | 'ro' | 'wo';
    property?: TuyaDeviceSchemaProperty;
  }>;
}

export interface TuyaPlatformLocalOptions {
  local?: TuyaPlatformLocalConfig;
  localDevices?: Array<TuyaPlatformLocalDeviceConfig>;
}

export interface TuyaPlatformLocalOnlyConfigOptions extends TuyaPlatformLocalOptions {
  projectType: '3'; // no cloud at all, devices come from the local snapshot and `localDevices`
  deviceOverrides?: Array<TuyaPlatformDeviceConfig>;
  debug?: boolean;
  debugLevel?: string;
}

export interface TuyaPlatformCustomConfigOptions extends TuyaPlatformLocalOptions {
  projectType: '1';
  endpoint: string;
  accessId: string;
  accessKey: string;
  username: string;
  password: string;
  deviceOverrides?: Array<TuyaPlatformDeviceConfig>;
  debug?: boolean;
  debugLevel?: string;
}

export interface TuyaPlatformHomeConfigOptions extends TuyaPlatformLocalOptions {
  projectType: '2';
  endpoint?: string;
  accessId: string;
  accessKey: string;
  countryCode: number;
  username: string;
  password: string;
  appSchema: string;
  homeWhitelist?: Array<number>;
  deviceOverrides?: Array<TuyaPlatformDeviceConfig>;
  debug?: boolean;
  debugLevel?: string;
}

export type TuyaPlatformConfigOptions = TuyaPlatformCustomConfigOptions
  | TuyaPlatformHomeConfigOptions
  | TuyaPlatformLocalOnlyConfigOptions;

export interface TuyaPlatformConfig extends PlatformConfig {
  options: TuyaPlatformConfigOptions;
}

export const localOptionsSchema = {
  properties: {
    local: { type: 'object' },
    localDevices: { type: 'array' },
    deviceOverrides: { 'type': 'array' },
    debug: { type: 'boolean' },
    debugLevel: { 'type': 'string' },
  },
};

export const customOptionsSchema = {
  properties: {
    endpoint: { type: 'string', format: 'url', required: true },
    accessId: { type: 'string', required: true },
    accessKey: { type: 'string', required: true },
    deviceOverrides: { 'type': 'array' },
    debug: { type: 'boolean' },
    debugLevel: { 'type': 'string' },
  },
};

export const homeOptionsSchema = {
  properties: {
    accessId: { type: 'string', required: true },
    accessKey: { type: 'string', required: true },
    endpoint: { type: 'string', format: 'url' },
    countryCode: { 'type': 'integer', 'minimum': 1, required: true },
    username: { type: 'string', required: true },
    password: { type: 'string', required: true },
    appSchema: { 'type': 'string', required: true },
    homeWhitelist: { 'type': 'array' },
    deviceOverrides: { 'type': 'array' },
    debug: { type: 'boolean' },
    debugLevel: { 'type': 'string' },
  },
};
