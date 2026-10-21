import EventEmitter from 'events';
import TuyAPI from 'tuyapi';
import Logger from '../util/Logger';

export type TuyaLocalDps = Record<string, string | number | boolean>;

export interface TuyaLocalConnectionOptions {
  id: string;
  key: string;
  ip?: string; // discovered over UDP when missing
  version?: string; // probed (3.3, 3.4, 3.5, 3.1) when missing
}

// The part of tuyapi that is used here, so tests can provide a fake.
export interface TuyaLocalClient {
  on(event: string, listener: (...args) => void): unknown;
  connect(): Promise<unknown>;
  disconnect(): unknown;
  get(options: { schema: true }): Promise<unknown>;
  set(options: { multiple: true; data: Record<string, unknown> }): Promise<unknown>;
  device?: { ip?: string };
}

export type TuyaLocalClientFactory = (options: Required<Pick<TuyaLocalConnectionOptions, 'id' | 'key'>>
  & { ip?: string; version: string }) => TuyaLocalClient;

const defaultFactory: TuyaLocalClientFactory = options => new TuyAPI({
  ...options,
  issueGetOnConnect: false,
  issueRefreshOnConnect: false,
}) as unknown as TuyaLocalClient;

const PROBE_VERSIONS = ['3.3', '3.4', '3.5', '3.1'];
const MIN_DELAY = 2000;
const MAX_DELAY = 60000;
const MAX_DELAY_NEVER_CONNECTED = 300000;

/**
 * One persistent LAN connection to a Tuya device (TCP 6668).
 * Pure transport: connects, reconnects with backoff, reads and writes DPs by id.
 *
 * Events: 'connected', 'disconnected', 'status' (dps), 'version' (string), 'ip' (string).
 */
export default class TuyaLocalConnection extends EventEmitter {

  public connected = false;
  public version: string;

  private versionKnown: boolean;
  private probeIndex = 0;
  private client?: TuyaLocalClient;
  private stopped = true;
  private everConnected = false;
  private retryDelay = MIN_DELAY;
  private timer?: NodeJS.Timeout;

  constructor(
    public readonly options: TuyaLocalConnectionOptions,
    private readonly log: Logger,
    private readonly factory: TuyaLocalClientFactory = defaultFactory,
  ) {
    super();
    this.versionKnown = options.version !== undefined;
    this.version = options.version ?? PROBE_VERSIONS[0];
  }

  start() {
    if (!this.stopped) {
      return;
    }
    this.stopped = false;
    void this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const client = this.client;
    this.client = undefined;
    this.markDisconnected();
    this.safeDisconnect(client);
  }

  async setDps(dps: Record<string, unknown>) {
    if (!this.connected || !this.client) {
      throw new Error('Local connection is not established');
    }
    await this.client.set({ multiple: true, data: dps });
  }

  private async connect() {
    if (this.stopped) {
      return;
    }

    const client = this.factory({
      id: this.options.id,
      key: this.options.key,
      ip: this.options.ip,
      version: this.version,
    });
    this.client = client;

    // tuyapi throws on unhandled 'error' events.
    client.on('error', error => this.log.debug('Local error (%s): %s', this.options.id, (error as Error)?.message ?? error));
    client.on('disconnected', () => this.onClientLost(client));
    client.on('data', data => this.onData(data));
    client.on('dp-refresh', data => this.onData(data));

    try {
      await client.connect();
      const status = await client.get({ schema: true });
      if (this.client !== client) {
        return; // stopped or replaced while connecting
      }
      this.connected = true;
      this.everConnected = true;
      this.retryDelay = MIN_DELAY;
      if (!this.versionKnown) {
        this.versionKnown = true;
        this.emit('version', this.version);
      }
      if (client.device?.ip) {
        this.emit('ip', client.device.ip);
      }
      this.emit('connected');
      this.onData(status);
    } catch (error) {
      this.log.debug('Local connect failed (%s, v%s): %s', this.options.id, this.version, (error as Error)?.message ?? error);
      this.onClientLost(client);
    }
  }

  private onData(data) {
    if (data && typeof data === 'object' && data.dps && typeof data.dps === 'object') {
      this.emit('status', data.dps as TuyaLocalDps);
    }
  }

  private onClientLost(client: TuyaLocalClient) {
    if (this.client !== client) {
      return;
    }
    this.client = undefined;
    this.markDisconnected();
    this.safeDisconnect(client);

    if (!this.versionKnown) {
      this.probeIndex = (this.probeIndex + 1) % PROBE_VERSIONS.length;
      this.version = PROBE_VERSIONS[this.probeIndex];
    }

    if (this.stopped) {
      return;
    }
    const delay = this.retryDelay;
    this.retryDelay = Math.min(this.retryDelay * 2, this.everConnected ? MAX_DELAY : MAX_DELAY_NEVER_CONNECTED);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.connect();
    }, delay);
    this.timer.unref?.();
  }

  private markDisconnected() {
    if (this.connected) {
      this.connected = false;
      this.emit('disconnected');
    }
  }

  private safeDisconnect(client?: TuyaLocalClient) {
    try {
      client?.disconnect();
    } catch (error) {
      // ignore
    }
  }

}
