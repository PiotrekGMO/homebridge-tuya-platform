
export enum TuyaDeviceSchemaMode {
  UNKNOWN = '',
  READ_WRITE = 'rw',
  READ_ONLY = 'ro',
  WRITE_ONLY = 'wo',
}

export enum TuyaDeviceSchemaType {
  Boolean = 'Boolean',
  Integer = 'Integer',
  Enum = 'Enum',
  String = 'String',
  Json = 'Json',
  Raw = 'Raw',
}

export type TuyaDeviceSchemaIntegerProperty = {
  min: number;
  max: number;
  scale: number;
  step: number;
  unit: string;
};

export type TuyaDeviceSchemaEnumProperty = {
  range: string[];
};

export type TuyaDeviceSchemaStringProperty = string;

export type TuyaDeviceSchemaJSONProperty = object;

export type TuyaDeviceSchemaProperty = TuyaDeviceSchemaIntegerProperty
  | TuyaDeviceSchemaEnumProperty
  | TuyaDeviceSchemaStringProperty
  | TuyaDeviceSchemaJSONProperty;

export type TuyaDeviceSchema = {
  code: string;
  // name: string;
  dp_id?: number; // data point id used by the local (LAN) protocol
  mode: TuyaDeviceSchemaMode;
  type: TuyaDeviceSchemaType;
  property: TuyaDeviceSchemaProperty;
};

export type TuyaDeviceStatus = {
  code: string;
  value: string | number | boolean;
};

export type TuyaIRRemoteKeyListItem = {
  key: string;
  key_id: number;
  key_name: string;
  standard_key: boolean;
  learning_code?: string; // IR DIY device learning code.
};

export type TuyaIRRemoteTempListItem = {
  temp: number;
  temp_name: string;
  fan_list: TuyaIRRemoteFanListItem[];
};

export type TuyaIRRemoteKeyRangeItem = {
  mode: number;
  mode_name: string;
  temp_list: TuyaIRRemoteTempListItem[];
};

export type TuyaIRRemoteFanListItem = {
  fan: number;
  fan_name: string;
};

export type TuyaIRRemoteKeys = {
  category_id: number;
  brand_id: number;
  remote_index: number;
  single_air: boolean;
  duplicate_power: boolean;
  key_list: TuyaIRRemoteKeyListItem[];
  key_range: TuyaIRRemoteKeyRangeItem[];
};

export default class TuyaDevice {

  // device
  id!: string;
  uuid!: string;
  name!: string;
  online!: boolean;
  owner_id!: string; // homeID or assetID

  // product
  product_id!: string;
  product_name!: string;
  icon!: string;
  category!: string;
  unbridged?: boolean;
  schema!: TuyaDeviceSchema[];

  // status
  status!: TuyaDeviceStatus[];

  // local (LAN) control
  local_key?: string;
  local?: { ip?: string; version?: string };

  // location
  ip!: string;
  lat!: string;
  lon!: string;
  time_zone!: string;

  // time
  create_time!: number;
  active_time!: number;
  update_time!: number;

  // ...
  sub!: boolean;
  parent_id?: string;
  remote_keys?: TuyaIRRemoteKeys;

  constructor(obj: Partial<TuyaDevice>) {
    Object.assign(this, obj);
    this.status.sort((a, b) => a.code > b.code ? 1 : -1);
  }

  isVirtualDevice() {
    return this.id.startsWith('vdevo');
  }

  // The category before a `deviceOverrides` category was applied.
  original_category?: string;

  isIRControlHub() {
    // A hub that is hidden through `deviceOverrides` still has to be used to reach its remotes.
    return [this.category, this.original_category]
      .some(category => category !== undefined && ['wnykq', 'hwktwkq', 'wsdykq'].includes(category));
  }

  isIRRemoteControl() {
    return this.remote_keys !== undefined;
  }

  /** Radio (433 MHz etc.) remote learned on an IR+RF hub, e.g. `rf_venetian_blind`. */
  isRFRemoteControl() {
    return this.isIRRemoteControl() && this.category.startsWith('rf_');
  }

}
