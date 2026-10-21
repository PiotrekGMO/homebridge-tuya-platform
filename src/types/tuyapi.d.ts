declare module 'tuyapi' {
  import { EventEmitter } from 'events';

  interface TuyAPIOptions {
    id?: string;
    key?: string;
    ip?: string;
    port?: number;
    version?: string;
    issueGetOnConnect?: boolean;
    issueRefreshOnConnect?: boolean;
    nullPayloadOnJSONError?: boolean;
  }

  export default class TuyAPI extends EventEmitter {
    constructor(options: TuyAPIOptions);
    device: { ip?: string; version?: string };
    find(options?: { timeout?: number; all?: boolean }): Promise<boolean | unknown>;
    connect(): Promise<boolean>;
    disconnect(): void;
    isConnected(): boolean;
    get(options?: { schema?: boolean; dps?: number | string; cid?: string }): Promise<unknown>;
    set(options: { multiple?: boolean; data?: Record<string, unknown>; dps?: number | string; set?: unknown }): Promise<unknown>;
  }
}
