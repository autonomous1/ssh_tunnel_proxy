/*
 * tunnel.ts — SSHTunnel, the first-class API.
 *
 * Scope, deliberately narrow:
 *   - Connect to an SSH listener that already exists at a host:port.
 *   - Maintain local (-L) and remote (-R) TCP forwards over that one transport.
 *   - Reconnect with bounded backoff and re-establish every declared forward.
 *   - Report state for the tunnel, each forward, and each proxied connection.
 *
 * Out of scope, on purpose: key generation, keychains, relay provisioning
 * (ngrok/zrok), SFTP, interactive shells, HTTP proxying, config file discovery.
 *
 * License: MIT
 */

import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import type { Writable } from 'node:stream';
import { Client, type ClientChannel, type ConnectConfig } from 'ssh2';

import type { TransportBridge } from './bridge';
import { TunnelError, asTunnelError } from './errors';
import {
  describeLocalForward,
  describeRemoteForward,
  parseAndValidateLocalForward,
  parseAndValidateRemoteForward,
  validateLocalForward,
  validateRemoteForward,
} from './forward-spec';
import { LocalForwardHandle } from './local-forward';
import { RemoteForwardHandle } from './remote-forward';
import { resolveAgentSocket, resolveCredential, type CredentialResolver } from './credentials';
import {
  DEFAULT_KEEPALIVE_COUNT_MAX,
  DEFAULT_KEEPALIVE_INTERVAL_MS,
  DEFAULT_READY_TIMEOUT_MS,
  DEFAULT_RECONNECT_POLICY,
  type ConnectionState,
  type ConnectionStatus,
  type Endpoint,
  type ForwardState,
  type ForwardStatus,
  type LocalForward,
  type RemoteForward,
  type TunnelConfig,
  type TunnelState,
  type TunnelStatus,
} from './model';

export interface TunnelEvents {
  state: (event: { previous: TunnelState; current: TunnelState; reason?: string }) => void;
  ready: (status: TunnelStatus) => void;
  forward: (event: { status: ForwardStatus; previous: ForwardState }) => void;
  connection: (event: { status: ConnectionStatus; previous: ConnectionState }) => void;
  reconnect: (event: { attempt: number; delayMs: number; cause?: string }) => void;
  error: (error: TunnelError) => void;
  close: (status: TunnelStatus) => void;
  debug: (message: string, ...args: unknown[]) => void;
}

export interface SSHTunnelOptions {
  /** Resolver for `{ source: 'callback' }` credential refs. */
  credentialResolver?: CredentialResolver;
  /** Destroy a proxied connection after this much inactivity. 0 disables. */
  connectionIdleTimeoutMs?: number;
  /** Timeout for dialling a remote-forward target. */
  targetConnectTimeoutMs?: number;
  /** Emit ssh2 protocol-level debug through the `debug` event. */
  debugSsh?: boolean;
}

const READY_STATES: ReadonlySet<TunnelState> = new Set<TunnelState>(['ready']);

export class SSHTunnel extends EventEmitter {
  public readonly tunnelId: string;

  private readonly config: TunnelConfig;
  private readonly options: SSHTunnelOptions;
  private readonly bridge: TransportBridge;

  private client?: Client;
  private state: TunnelState = 'idle';
  private lastError?: string;
  private connectedAtUnixMs?: number;
  private reconnectAttempt = 0;
  private reconnectTimer?: NodeJS.Timeout;
  private connectPromise?: Promise<TunnelStatus>;
  private closing = false;

  private readonly localForwards = new Map<string, LocalForwardHandle>();
  private readonly remoteForwards = new Map<string, RemoteForwardHandle>();

  constructor(config: TunnelConfig, options: SSHTunnelOptions = {}) {
    super();
    this.config = config;
    this.options = options;
    this.tunnelId = config.id ?? `${config.transport.endpoint.host}:${config.transport.endpoint.port}`;

    this.bridge = {
      requireClient: (forwardId: string) => {
        if (!this.client || !READY_STATES.has(this.state)) {
          throw new TunnelError(
            'TRANSPORT_NOT_READY',
            `Tunnel ${this.tunnelId} is ${this.state}`,
            { forwardId },
          );
        }
        return this.client;
      },
      peekClient: () => this.client,
      onConnectionChanged: (status, previous) => {
        this.emit('connection', { status, previous });
      },
      onForwardChanged: (status, previous) => {
        this.emit('forward', { status, previous });
      },
      onError: (error) => this.raise(error),
      debug: (message, ...args) => this.emit('debug', message, ...args),
    };
  }

  // -------------------------------------------------------------------------
  // Typed event surface
  // -------------------------------------------------------------------------

  public override on<E extends keyof TunnelEvents>(event: E, listener: TunnelEvents[E]): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  public override once<E extends keyof TunnelEvents>(event: E, listener: TunnelEvents[E]): this {
    return super.once(event, listener as (...args: unknown[]) => void);
  }

  public override off<E extends keyof TunnelEvents>(event: E, listener: TunnelEvents[E]): this {
    return super.off(event, listener as (...args: unknown[]) => void);
  }

  public override emit<E extends keyof TunnelEvents>(
    event: E,
    ...args: Parameters<TunnelEvents[E]>
  ): boolean {
    return super.emit(event, ...args);
  }

  // -------------------------------------------------------------------------
  // Status
  // -------------------------------------------------------------------------

  public getState(): TunnelState {
    return this.state;
  }

  public isReady(): boolean {
    return READY_STATES.has(this.state);
  }

  public getStatus(): TunnelStatus {
    return {
      tunnelId: this.tunnelId,
      state: this.state,
      endpoint: { ...this.config.transport.endpoint },
      reconnectAttempt: this.reconnectAttempt,
      connectedAtUnixMs: this.connectedAtUnixMs,
      forwards: [
        ...[...this.localForwards.values()].map((handle) => handle.getStatus()),
        ...[...this.remoteForwards.values()].map((handle) => handle.getStatus()),
      ],
      error: this.lastError,
    };
  }

  public listConnections(): ConnectionStatus[] {
    return [
      ...[...this.localForwards.values()].flatMap((handle) => handle.listConnections()),
      ...[...this.remoteForwards.values()].flatMap((handle) => handle.listConnections()),
    ];
  }

  public getForwardStatus(forwardId: string): ForwardStatus {
    const handle = this.localForwards.get(forwardId) ?? this.remoteForwards.get(forwardId);
    if (!handle) {
      throw new TunnelError('UNKNOWN_FORWARD', `No forward with id "${forwardId}"`, { forwardId });
    }
    return handle.getStatus();
  }

  /**
   * Resolve a semantic forward id to the endpoint a caller should connect to.
   * This is the hook an agent-flow runtime uses instead of hard-coding ports.
   */
  public resolveEndpoint(forwardId: string): { endpoint: Endpoint; state: ForwardState } {
    const local = this.localForwards.get(forwardId);
    if (local) {
      return { endpoint: { ...local.spec.listen }, state: local.getState() };
    }
    const remote = this.remoteForwards.get(forwardId);
    if (remote) {
      return {
        endpoint: { host: remote.spec.bind.host, port: remote.getBoundPort() },
        state: remote.getState(),
      };
    }
    throw new TunnelError('UNKNOWN_FORWARD', `No forward with id "${forwardId}"`, { forwardId });
  }

  // -------------------------------------------------------------------------
  // Connect / close
  // -------------------------------------------------------------------------

  /**
   * Establish the transport and open every forward declared in the config.
   * Concurrent calls share one attempt. Resolves when all forwards are active.
   */
  public async connect(): Promise<TunnelStatus> {
    if (this.isReady()) return this.getStatus();
    if (this.connectPromise) return this.connectPromise;

    this.closing = false;
    this.connectPromise = this.doConnect().finally(() => {
      this.connectPromise = undefined;
    });
    return this.connectPromise;
  }

  private async doConnect(): Promise<TunnelStatus> {
    this.transition('connecting');

    let connectConfig: ConnectConfig;
    try {
      connectConfig = await this.buildConnectConfig();
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.transition('failed', this.lastError);
      throw err;
    }

    const client = new Client();
    // ssh2 emits `error` on handshake abort. Absorb it before any other
    // listener is attached or torn down so Mocha never sees an uncaught
    // "Connection lost before handshake".
    client.on('error', () => {});
    this.client = client;
    this.attachClientHandlers(client);

    try {
      await new Promise<void>((resolve, reject) => {
        const timeoutMs = connectConfig.readyTimeout ?? DEFAULT_READY_TIMEOUT_MS;
        let settled = false;
        const finish = (fn: () => void) => {
          if (settled) return;
          settled = true;
          clearTimeout(handshakeTimer);
          fn();
        };
        const handshakeTimer = setTimeout(() => {
          finish(() =>
            reject(
              new TunnelError(
                'TRANSPORT_NOT_READY',
                `SSH handshake to ${this.config.transport.endpoint.host}:${this.config.transport.endpoint.port} timed out after ${timeoutMs}ms`,
              ),
            ),
          );
        }, timeoutMs);
        const onReady = () => {
          client.removeListener('error', onError);
          finish(() => resolve());
        };
        const onError = (err: Error) => {
          client.removeListener('ready', onReady);
          const code = /All configured authentication methods failed/i.test(err.message)
            ? 'AUTH_FAILED'
            : 'TRANSPORT_NOT_READY';
          finish(() =>
            reject(
              asTunnelError(
                code,
                `Cannot establish SSH transport to ${this.config.transport.endpoint.host}:${this.config.transport.endpoint.port}`,
                err,
              ),
            ),
          );
        };
        client.once('ready', onReady);
        client.once('error', onError);
        client.connect(connectConfig);
      });
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.safeEndClient(client);
      this.client = undefined;
      if (this.shouldReconnect()) {
        this.transition('reconnecting', this.lastError);
        this.scheduleReconnect(this.lastError);
        return this.getStatus();
      }
      this.transition('failed', this.lastError);
      throw err;
    }

    this.connectedAtUnixMs = Date.now();
    this.lastError = undefined;
    this.transition('ready');

    try {
      await this.declareConfiguredForwards();
      await this.reopenForwards();
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      await this.close();
      throw err;
    }

    this.reconnectAttempt = 0;
    this.emit('ready', this.getStatus());
    return this.getStatus();
  }

  /** Close every forward and the transport. Idempotent. */
  public async close(): Promise<TunnelStatus> {
    if (this.state === 'closed') return this.getStatus();
    this.closing = true;
    this.transition('closing');

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    for (const handle of [...this.remoteForwards.values()]) {
      await handle.close().catch(() => undefined);
    }
    for (const handle of [...this.localForwards.values()]) {
      await handle.close().catch(() => undefined);
    }

    const client = this.client;
    this.client = undefined;
    if (client) {
      await new Promise<void>((resolve) => {
        const done = () => resolve();
        client.once('close', done);
        try {
          client.end();
        } catch {
          resolve();
          return;
        }
        setTimeout(done, 2000);
      });
      this.safeEndClient(client);
    }

    this.transition('closed');
    this.emit('close', this.getStatus());
    return this.getStatus();
  }

  // -------------------------------------------------------------------------
  // Forwards
  // -------------------------------------------------------------------------

  /** Declare and open one local forward. Accepts a struct or a v1 spec string. */
  public async addLocalForward(forward: LocalForward | string): Promise<ForwardStatus> {
    const [status] = await this.addLocalForwards([forward]);
    return status;
  }

  /**
   * Declare and open several local forwards atomically: either every listener is
   * bound, or none are and the partial state is rolled back.
   */
  public async addLocalForwards(
    forwards: readonly (LocalForward | string)[],
  ): Promise<ForwardStatus[]> {
    const handles = forwards.map((input) => this.declareLocalForward(input));
    const opened: LocalForwardHandle[] = [];
    try {
      for (const handle of handles) {
        await handle.open();
        opened.push(handle);
      }
    } catch (err) {
      for (const handle of opened) {
        await handle.close().catch(() => undefined);
        this.localForwards.delete(handle.forwardId);
      }
      for (const handle of handles) {
        if (!opened.includes(handle)) this.localForwards.delete(handle.forwardId);
      }
      throw err;
    }
    return handles.map((handle) => handle.getStatus());
  }

  /** Declare and open one remote forward. Accepts a struct or a v1 spec string. */
  public async addRemoteForward(forward: RemoteForward | string): Promise<ForwardStatus> {
    const [status] = await this.addRemoteForwards([forward]);
    return status;
  }

  /** Declare and open several remote forwards atomically. */
  public async addRemoteForwards(
    forwards: readonly (RemoteForward | string)[],
  ): Promise<ForwardStatus[]> {
    const handles = forwards.map((input) => this.declareRemoteForward(input));
    const opened: RemoteForwardHandle[] = [];
    try {
      for (const handle of handles) {
        await handle.open();
        opened.push(handle);
      }
    } catch (err) {
      for (const handle of opened) {
        await handle.close().catch(() => undefined);
        this.remoteForwards.delete(handle.forwardId);
      }
      for (const handle of handles) {
        if (!opened.includes(handle)) this.remoteForwards.delete(handle.forwardId);
      }
      throw err;
    }
    return handles.map((handle) => handle.getStatus());
  }

  /** Close and forget one forward. */
  public async removeForward(forwardId: string): Promise<ForwardStatus> {
    const local = this.localForwards.get(forwardId);
    if (local) {
      const status = await local.close();
      this.localForwards.delete(forwardId);
      return status;
    }
    const remote = this.remoteForwards.get(forwardId);
    if (remote) {
      const status = await remote.close();
      this.remoteForwards.delete(forwardId);
      return status;
    }
    throw new TunnelError('UNKNOWN_FORWARD', `No forward with id "${forwardId}"`, { forwardId });
  }

  private declareLocalForward(input: LocalForward | string): LocalForwardHandle {
    const spec =
      typeof input === 'string'
        ? parseAndValidateLocalForward(input, this.config.portPolicy)
        : validateLocalForward(input, this.config.portPolicy);
    const forwardId = spec.id ?? describeLocalForward(spec);
    const existing = this.localForwards.get(forwardId);
    if (existing && existing.getState() !== 'closed') {
      if (spec.exclusive) {
        throw new TunnelError(
          'DUPLICATE_FORWARD_ID',
          `Local forward "${forwardId}" is already declared`,
          { forwardId },
        );
      }
      return existing;
    }
    const handle = new LocalForwardHandle(
      { ...spec, id: forwardId },
      this.bridge,
      this.options.connectionIdleTimeoutMs ?? 0,
    );
    this.localForwards.set(forwardId, handle);
    return handle;
  }

  private declareRemoteForward(input: RemoteForward | string): RemoteForwardHandle {
    const spec =
      typeof input === 'string'
        ? parseAndValidateRemoteForward(input, this.config.portPolicy)
        : validateRemoteForward(input, this.config.portPolicy);
    const forwardId = spec.id ?? describeRemoteForward(spec);
    const existing = this.remoteForwards.get(forwardId);
    if (existing && existing.getState() !== 'closed') {
      return existing;
    }
    const handle = new RemoteForwardHandle(
      { ...spec, id: forwardId },
      this.bridge,
      this.options.connectionIdleTimeoutMs ?? 0,
      this.options.targetConnectTimeoutMs ?? 10000,
    );
    this.remoteForwards.set(forwardId, handle);
    return handle;
  }

  private async declareConfiguredForwards(): Promise<void> {
    for (const forward of this.config.localForwards ?? []) {
      this.declareLocalForward(forward);
    }
    for (const forward of this.config.remoteForwards ?? []) {
      this.declareRemoteForward(forward);
    }
  }

  /** Open, or re-open after a reconnect, every declared forward. */
  private async reopenForwards(): Promise<void> {
    for (const handle of this.localForwards.values()) {
      const state = handle.getState();
      if (state === 'active') continue;
      if (state === 'degraded') {
        handle.markActive();
        continue;
      }
      if (state === 'closed' || state === 'closing') continue;
      await handle.open();
    }
    for (const handle of this.remoteForwards.values()) {
      const state = handle.getState();
      if (state === 'active') continue;
      if (state === 'closed' || state === 'closing') continue;
      await handle.open();
    }
  }

  // -------------------------------------------------------------------------
  // Optional convenience: run one non-interactive command
  // -------------------------------------------------------------------------

  /**
   * Run a single command on the peer. Provided because verifying a tunnel almost
   * always involves one command; there is deliberately no pty or shell support.
   */
  public exec(
    command: string,
    streams: { stdout?: Writable; stderr?: Writable } = {},
  ): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const client = this.bridge.requireClient('exec');
    return new Promise((resolve, reject) => {
      client.exec(command, (err, stream: ClientChannel) => {
        if (err) {
          reject(asTunnelError('CHANNEL_OPEN_FAILED', `exec failed: ${command}`, err));
          return;
        }
        let stdout = '';
        let stderr = '';
        let code: number | null = null;
        stream.on('data', (chunk: Buffer) => {
          stdout += chunk.toString();
          streams.stdout?.write(chunk);
        });
        stream.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString();
          streams.stderr?.write(chunk);
        });
        stream.once('exit', (exitCode: number) => {
          code = exitCode;
        });
        stream.once('close', () => resolve({ code, stdout, stderr }));
      });
    });
  }

  // -------------------------------------------------------------------------
  // Transport plumbing
  // -------------------------------------------------------------------------

  private async buildConnectConfig(): Promise<ConnectConfig> {
    const transport = this.config.transport;

    const privateKey = await resolveCredential(transport.privateKey, {
      resolver: this.options.credentialResolver,
      label: 'private key',
    });
    const passphrase = await resolveCredential(transport.passphrase, {
      resolver: this.options.credentialResolver,
      label: 'passphrase',
    });
    const password = await resolveCredential(transport.password, {
      resolver: this.options.credentialResolver,
      label: 'password',
    });
    const agent = resolveAgentSocket(transport.privateKey);

    if (!privateKey && !password && !agent) {
      throw new TunnelError(
        'CREDENTIAL_UNRESOLVED',
        'No authentication material: supply transport.privateKey, transport.password, or an agent ref',
      );
    }

    const config: ConnectConfig = {
      host: transport.endpoint.host,
      port: transport.endpoint.port,
      username: transport.username,
      keepaliveInterval: transport.keepaliveIntervalMs ?? DEFAULT_KEEPALIVE_INTERVAL_MS,
      keepaliveCountMax: transport.keepaliveCountMax ?? DEFAULT_KEEPALIVE_COUNT_MAX,
      readyTimeout: transport.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
    };

    if (privateKey) config.privateKey = privateKey;
    if (passphrase) config.passphrase = passphrase as string;
    if (password) config.password = password as string;
    if (agent) config.agent = agent;

    const fingerprints = transport.hostKeyFingerprints;
    if (fingerprints && fingerprints.length > 0) {
      const expected = new Set(fingerprints.map((value) => value.trim()));
      config.hostVerifier = (key: Buffer | string) => {
        const buffer = typeof key === 'string' ? Buffer.from(key, 'base64') : key;
        const digest = createHash('sha256').update(buffer).digest('base64').replace(/=+$/, '');
        return expected.has(`sha256:${digest}`) || expected.has(digest);
      };
    }

    if (this.options.debugSsh) {
      config.debug = (message: string) => this.emit('debug', message);
    }

    return config;
  }

  private attachClientHandlers(client: Client): void {
    client.on('tcp connection', (details, accept, reject) => {
      const destIP = String(details.destIP ?? '');
      const destPort = Number(details.destPort ?? 0);
      const handle = [...this.remoteForwards.values()].find((candidate) =>
        candidate.matches(destIP, destPort),
      );

      if (!handle) {
        this.raise(
          new TunnelError(
            'UNKNOWN_FORWARD',
            `Rejected unexpected inbound channel for ${destIP}:${destPort}`,
          ),
        );
        reject();
        return;
      }

      handle.acceptChannel(accept, reject, {
        host: String(details.srcIP ?? ''),
        port: Number(details.srcPort ?? 0),
      });
    });

    client.on('error', (err: Error) => {
      this.lastError = err.message;
      this.raise(asTunnelError('TRANSPORT_NOT_READY', 'SSH transport error', err));
    });

    client.on('close', () => {
      if (this.client !== client) return;
      this.handleTransportLoss('transport closed');
    });

    client.on('end', () => {
      this.emit('debug', 'ssh transport ended');
    });
  }

  private handleTransportLoss(reason: string): void {
    if (this.closing || this.state === 'closing' || this.state === 'closed') return;

    this.client = undefined;
    this.connectedAtUnixMs = undefined;

    for (const handle of this.localForwards.values()) handle.markDegraded(reason);
    for (const handle of this.remoteForwards.values()) handle.markDegraded(reason);

    if (!this.shouldReconnect()) {
      this.transition('failed', reason);
      return;
    }

    this.transition('reconnecting', reason);
    this.scheduleReconnect(reason);
  }

  private shouldReconnect(): boolean {
    if (this.closing) return false;
    const policy = { ...DEFAULT_RECONNECT_POLICY, ...(this.config.reconnect ?? {}) };
    if (!policy.enabled) return false;
    if (policy.maxAttempts === 0) return true;
    return this.reconnectAttempt < policy.maxAttempts;
  }

  private scheduleReconnect(cause?: string): void {
    const policy = { ...DEFAULT_RECONNECT_POLICY, ...(this.config.reconnect ?? {}) };
    this.reconnectAttempt += 1;

    const base = Math.min(
      policy.initialDelayMs * Math.pow(policy.backoffMultiplier, this.reconnectAttempt - 1),
      policy.maxDelayMs,
    );
    const jitter = base * policy.jitterRatio * (Math.random() * 2 - 1);
    const delayMs = Math.max(50, Math.round(base + jitter));

    this.emit('reconnect', { attempt: this.reconnectAttempt, delayMs, cause });

    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.closing) return;
      void this.doConnect().catch((err) => {
        this.raise(
          err instanceof TunnelError
            ? err
            : asTunnelError('TRANSPORT_NOT_READY', 'Reconnect attempt failed', err),
        );
        if (!this.shouldReconnect()) {
          this.raise(
            new TunnelError(
              'RECONNECT_EXHAUSTED',
              `Giving up after ${this.reconnectAttempt} reconnect attempts`,
            ),
          );
          this.transition('failed', 'reconnect exhausted');
        }
      });
    }, delayMs);
    this.reconnectTimer.unref?.();
  }

  private safeEndClient(client: Client): void {
    try {
      client.removeAllListeners();
      client.on('error', () => {
        /* socket close after handshake abort */
      });
      client.end();
      client.destroy();
    } catch {
      // best effort
    }
  }

  private transition(next: TunnelState, reason?: string): void {
    if (this.state === next) return;
    const previous = this.state;
    this.state = next;
    this.emit('state', { previous, current: next, reason });
  }

  /** Emit an error without the unhandled-'error' crash when nobody listens. */
  private raise(error: TunnelError): void {
    this.lastError = error.message;
    if (this.listenerCount('error') > 0) {
      this.emit('error', error);
    } else {
      this.emit('debug', `unhandled tunnel error [${error.code}] ${error.message}`);
    }
  }
}
