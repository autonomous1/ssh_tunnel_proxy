/*
 * local-forward.ts — ssh -L, as a first-class object.
 *
 * One handle owns one listening socket and every connection accepted on it. The
 * handle can be opened, closed, and re-opened across transport restarts without
 * the caller re-declaring it, which is what makes reconnection transparent.
 *
 * License: MIT
 */

import { createServer, type Server, type Socket } from 'node:net';

import type { TransportBridge } from './bridge';
import { ProxiedConnection } from './connection';
import { TunnelError, asTunnelError } from './errors';
import { describeLocalForward } from './forward-spec';
import type { ForwardState, ForwardStatus, LocalForward } from './model';

export class LocalForwardHandle {
  public readonly forwardId: string;
  public readonly spec: LocalForward;

  private state: ForwardState = 'pending';
  private server?: Server;
  private lastError?: string;
  private totalConnections = 0;
  private readonly connections = new Map<string, ProxiedConnection>();
  private readonly bridge: TransportBridge;
  private readonly idleTimeoutMs: number;

  constructor(spec: LocalForward, bridge: TransportBridge, idleTimeoutMs = 0) {
    this.spec = spec;
    this.forwardId = spec.id ?? describeLocalForward(spec);
    this.bridge = bridge;
    this.idleTimeoutMs = idleTimeoutMs;
  }

  public getState(): ForwardState {
    return this.state;
  }

  public getStatus(): ForwardStatus {
    return {
      forwardId: this.forwardId,
      direction: 'local',
      state: this.state,
      listen: { ...this.spec.listen },
      target: { ...this.spec.target },
      assignedPort: (this.server?.address() as { port?: number } | null)?.port,
      activeConnections: this.connections.size,
      totalConnections: this.totalConnections,
      error: this.lastError,
    };
  }

  public listConnections() {
    return [...this.connections.values()].map((connection) => connection.getStatus());
  }

  /** Bind the local listener. Resolves once the port is actually listening. */
  public async open(): Promise<ForwardStatus> {
    if (this.state === 'active') return this.getStatus();
    // A flap can call open() while the previous listener is still bound
    // (state opening/degraded/failed). Reusing it avoids leaking servers.
    if (this.server?.listening) {
      this.lastError = undefined;
      this.transition('active');
      return this.getStatus();
    }
    this.transition('opening');

    const server = createServer({ allowHalfOpen: true }, (socket) => {
      this.handleSocket(socket);
    });
    this.server = server;

    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => {
          server.removeListener('listening', onListening);
          reject(
            asTunnelError(
              'LISTEN_FAILED',
              `Cannot bind ${this.spec.listen.host}:${this.spec.listen.port}`,
              err,
              { forwardId: this.forwardId },
            ),
          );
        };
        const onListening = () => {
          server.removeListener('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(this.spec.listen.port, this.spec.listen.host);
      });
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.server = undefined;
      try {
        server.close();
      } catch {
        /* already unusable */
      }
      this.transition('failed');
      throw err;
    }

    // Post-bind errors are reported, not thrown: the listener stays usable.
    server.on('error', (err: Error) => {
      this.lastError = err.message;
      this.bridge.onError(
        asTunnelError('LISTEN_FAILED', `Listener error on ${this.forwardId}`, err, {
          forwardId: this.forwardId,
        }),
      );
    });

    this.transition('active');
    this.bridge.debug(
      `local forward active ${this.spec.listen.host}:${this.spec.listen.port} -> ${this.spec.target.host}:${this.spec.target.port}`,
    );
    return this.getStatus();
  }

  /**
   * Mark the forward as degraded: the listener stays bound so callers do not see
   * connection-refused during a reconnect, but new connections fail fast until
   * the transport returns.
   */
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

  public async close(): Promise<ForwardStatus> {
    if (this.state === 'closed') return this.getStatus();
    this.transition('closing');
    this.closeConnections();

    const server = this.server;
    this.server = undefined;

    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        // close() only waits for existing connections; ours are already gone.
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

  private handleSocket(socket: Socket): void {
    const limit = this.spec.maxConnections ?? 0;
    if (limit > 0 && this.connections.size >= limit) {
      this.bridge.onError(
        new TunnelError(
          'CONNECTION_LIMIT',
          `Forward ${this.forwardId} reached maxConnections=${limit}`,
          { forwardId: this.forwardId },
        ),
      );
      socket.destroy();
      return;
    }

    const sourceHost = socket.remoteAddress ?? this.spec.listen.host;
    const sourcePort = socket.remotePort ?? 0;

    const connection = new ProxiedConnection({
      forwardId: this.forwardId,
      direction: 'local',
      source: { host: sourceHost, port: sourcePort },
      destination: { ...this.spec.target },
      idleTimeoutMs: this.idleTimeoutMs,
      onStateChange: (status, previous) => {
        if (status.state === 'closed' || status.state === 'failed') {
          this.connections.delete(status.connectionId);
        }
        this.bridge.onConnectionChanged(status, previous);
      },
    });

    // Adopt the socket immediately so every failure path below destroys it.
    connection.adoptInbound(socket);
    this.connections.set(connection.connectionId, connection);
    this.totalConnections += 1;

    if (this.state !== 'active') {
      connection.fail(
        new TunnelError('TRANSPORT_NOT_READY', `Forward ${this.forwardId} is ${this.state}`, {
          forwardId: this.forwardId,
          connectionId: connection.connectionId,
        }),
      );
      return;
    }

    let client;
    try {
      client = this.bridge.requireClient(this.forwardId);
    } catch (err) {
      connection.fail(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    connection.markOpening();

    // Pause until the channel exists so no inbound bytes are dropped.
    socket.pause();

    const openTimer = setTimeout(() => {
      if (connection.isClosed()) return;
      const wrapped = new TunnelError(
        'CHANNEL_OPEN_FAILED',
        `forwardOut to ${this.spec.target.host}:${this.spec.target.port} timed out`,
        { forwardId: this.forwardId, connectionId: connection.connectionId },
      );
      this.bridge.onError(wrapped);
      connection.fail(wrapped, 'channel');
    }, 8000);

    try {
      client.forwardOut(
        sourceHost,
        sourcePort,
        this.spec.target.host,
        this.spec.target.port,
        (err, stream) => {
          clearTimeout(openTimer);
          if (connection.isClosed()) {
            if (stream && !stream.destroyed) stream.destroy();
            return;
          }
          if (err) {
            const wrapped = asTunnelError(
              'CHANNEL_OPEN_FAILED',
              `forwardOut to ${this.spec.target.host}:${this.spec.target.port} failed`,
              err,
              { forwardId: this.forwardId, connectionId: connection.connectionId },
            );
            this.bridge.onError(wrapped);
            connection.fail(wrapped, 'channel');
            return;
          }

          connection.attach(socket, stream);
          socket.resume();
        },
      );
    } catch (err) {
      clearTimeout(openTimer);
      const wrapped = asTunnelError(
        'TRANSPORT_NOT_READY',
        `forwardOut to ${this.spec.target.host}:${this.spec.target.port} failed`,
        err,
        { forwardId: this.forwardId, connectionId: connection.connectionId },
      );
      this.bridge.onError(wrapped);
      connection.fail(wrapped, 'channel');
    }
  }

  private transition(next: ForwardState): void {
    if (this.state === next) return;
    const previous = this.state;
    this.state = next;
    this.bridge.onForwardChanged(this.getStatus(), previous);
  }
}
