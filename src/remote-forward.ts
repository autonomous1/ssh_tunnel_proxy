/*
 * remote-forward.ts — ssh -R, as a first-class object.
 *
 * The important correctness fix relative to v1: a fresh outbound TCP socket is
 * created for every inbound channel. v1 created one socket per registration and
 * reused it for every connection, so a second concurrent connection interleaved
 * bytes into the same stream. All channels still share one SSH transport.
 *
 * License: MIT
 */

import { Socket } from 'node:net';
import type { ClientChannel } from 'ssh2';

import type { TransportBridge } from './bridge';
import { ProxiedConnection } from './connection';
import { TunnelError, asTunnelError } from './errors';
import { describeRemoteForward } from './forward-spec';
import type { ForwardState, ForwardStatus, RemoteForward } from './model';

export class RemoteForwardHandle {
  public readonly forwardId: string;
  public readonly spec: RemoteForward;

  private state: ForwardState = 'pending';
  private assignedPort?: number;
  private lastError?: string;
  private totalConnections = 0;
  private readonly connections = new Map<string, ProxiedConnection>();
  private readonly bridge: TransportBridge;
  private readonly idleTimeoutMs: number;
  private readonly connectTimeoutMs: number;

  constructor(
    spec: RemoteForward,
    bridge: TransportBridge,
    idleTimeoutMs = 0,
    connectTimeoutMs = 10000,
  ) {
    this.spec = spec;
    this.forwardId = spec.id ?? describeRemoteForward(spec);
    this.bridge = bridge;
    this.idleTimeoutMs = idleTimeoutMs;
    this.connectTimeoutMs = connectTimeoutMs;
  }

  public getState(): ForwardState {
    return this.state;
  }

  /** The port the peer actually bound; differs from the request when 0 was asked. */
  public getBoundPort(): number {
    return this.assignedPort ?? this.spec.bind.port;
  }

  public getStatus(): ForwardStatus {
    return {
      forwardId: this.forwardId,
      direction: 'remote',
      state: this.state,
      listen: { host: this.spec.bind.host, port: this.getBoundPort() },
      target: { ...this.spec.target },
      assignedPort: this.assignedPort,
      activeConnections: this.connections.size,
      totalConnections: this.totalConnections,
      error: this.lastError,
    };
  }

  public listConnections() {
    return [...this.connections.values()].map((connection) => connection.getStatus());
  }

  /** True when an inbound `tcp connection` event belongs to this forward. */
  public matches(destIP: string, destPort: number): boolean {
    if (destPort !== this.getBoundPort()) return false;
    const bind = this.spec.bind.host;
    if (bind === destIP) return true;
    // The peer reports the address it actually bound, which rarely matches the
    // request verbatim: "localhost" vs "127.0.0.1", "" vs "0.0.0.0".
    const loopback = new Set(['localhost', '127.0.0.1', '::1']);
    if (loopback.has(bind) && loopback.has(destIP)) return true;
    const wildcard = new Set(['', '*', '0.0.0.0', '::']);
    return wildcard.has(bind) || wildcard.has(destIP);
  }

  /** Ask the peer to bind the listener. Resolves with the bound port. */
  public async open(): Promise<ForwardStatus> {
    if (this.state === 'active') return this.getStatus();
    this.transition('opening');

    const client = this.bridge.requireClient(this.forwardId);

    try {
      this.assignedPort = await new Promise<number>((resolve, reject) => {
        client.forwardIn(this.spec.bind.host, this.spec.bind.port, (err, port) => {
          if (err) {
            reject(
              asTunnelError(
                'REMOTE_BIND_FAILED',
                `Peer refused to bind ${this.spec.bind.host}:${this.spec.bind.port}`,
                err,
                { forwardId: this.forwardId },
              ),
            );
            return;
          }
          resolve(port ?? this.spec.bind.port);
        });
      });
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.transition('failed');
      throw err;
    }

    this.transition('active');
    this.bridge.debug(
      `remote forward active peer ${this.spec.bind.host}:${this.getBoundPort()} -> ${this.spec.target.host}:${this.spec.target.port}`,
    );
    return this.getStatus();
  }

  /**
   * Handle an inbound channel from the peer by dialling the target with a fresh
   * socket. Returns false if the channel was rejected.
   */
  public acceptChannel(
    accept: () => ClientChannel,
    reject: () => void,
    source: { host: string; port: number },
  ): boolean {
    if (this.state !== 'active') {
      this.bridge.onError(
        new TunnelError(
          'TRANSPORT_NOT_READY',
          `Remote forward ${this.forwardId} is ${this.state}; rejecting channel`,
          { forwardId: this.forwardId },
        ),
      );
      reject();
      return false;
    }

    const limit = this.spec.maxConnections ?? 0;
    if (limit > 0 && this.connections.size >= limit) {
      this.bridge.onError(
        new TunnelError(
          'CONNECTION_LIMIT',
          `Forward ${this.forwardId} reached maxConnections=${limit}`,
          { forwardId: this.forwardId },
        ),
      );
      reject();
      return false;
    }

    const connection = new ProxiedConnection({
      forwardId: this.forwardId,
      direction: 'remote',
      source,
      destination: { ...this.spec.target },
      idleTimeoutMs: this.idleTimeoutMs,
      onStateChange: (status, previous) => {
        if (status.state === 'closed' || status.state === 'failed') {
          this.connections.delete(status.connectionId);
        }
        this.bridge.onConnectionChanged(status, previous);
      },
    });

    this.connections.set(connection.connectionId, connection);
    this.totalConnections += 1;
    connection.markOpening();

    const channel = accept();
    channel.pause();
    // Adopt the channel now so an unreachable target still closes it, instead of
    // leaving whoever connected on the peer waiting forever.
    connection.adoptInbound(channel);

    // One socket per channel. This is the concurrency fix.
    const socket = new Socket();
    let settled = false;

    const timer =
      this.connectTimeoutMs > 0
        ? setTimeout(() => {
            if (settled) return;
            settled = true;
            const err = new TunnelError(
              'TARGET_UNREACHABLE',
              `Timed out connecting to ${this.spec.target.host}:${this.spec.target.port}`,
              { forwardId: this.forwardId, connectionId: connection.connectionId },
            );
            this.bridge.onError(err);
            socket.destroy();
            connection.fail(err, 'outbound');
          }, this.connectTimeoutMs)
        : undefined;

    socket.once('error', (err: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const wrapped = asTunnelError(
        'TARGET_UNREACHABLE',
        `Cannot reach ${this.spec.target.host}:${this.spec.target.port}`,
        err,
        { forwardId: this.forwardId, connectionId: connection.connectionId },
      );
      this.bridge.onError(wrapped);
      connection.fail(wrapped, 'outbound');
    });

    socket.once('connect', () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      connection.attach(channel, socket);
      channel.resume();
    });

    socket.connect({
      host: this.spec.target.host,
      port: this.spec.target.port,
      keepAlive: true,
    });

    return true;
  }

  public markDegraded(reason: string): void {
    if (this.state === 'closed' || this.state === 'closing') return;
    this.lastError = reason;
    this.closeConnections();
    this.transition('degraded');
  }

  public markActive(): void {
    if (this.state === 'degraded') {
      this.lastError = undefined;
      this.transition('active');
    }
  }

  /** Unbind on the peer. Tolerates a transport that has already gone away. */
  public async close(): Promise<ForwardStatus> {
    if (this.state === 'closed') return this.getStatus();
    const wasActive = this.state === 'active';
    this.transition('closing');
    this.closeConnections();

    const client = this.bridge.peekClient();
    if (client && wasActive) {
      await new Promise<void>((resolve) => {
        try {
          client.unforwardIn(this.spec.bind.host, this.getBoundPort(), () => resolve());
        } catch {
          resolve();
        }
      });
    }

    this.transition('closed');
    return this.getStatus();
  }

  private closeConnections(): void {
    for (const connection of [...this.connections.values()]) {
      connection.close();
    }
    this.connections.clear();
  }

  private transition(next: ForwardState): void {
    if (this.state === next) return;
    const previous = this.state;
    this.state = next;
    this.bridge.onForwardChanged(this.getStatus(), previous);
  }
}
