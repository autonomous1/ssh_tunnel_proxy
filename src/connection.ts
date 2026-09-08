/*
 * connection.ts — one proxied TCP connection, with explicit state.
 *
 * v1 piped a socket and a channel together and hoped for the best. The failure
 * modes that produced were: half-open connections that never closed, `unpipe`
 * called on an already-destroyed stream, errors on one side leaving the other
 * side leaking, and no way to enumerate what was currently open.
 *
 * This class makes each connection a first-class, observable object:
 *   - a single explicit state machine (accepted -> opening -> piped -> closed)
 *   - byte counters in both directions
 *   - idempotent teardown that always destroys both sides exactly once
 *   - errors attributed to a connection id rather than logged anonymously
 *
 * License: MIT
 */

import { randomUUID } from 'node:crypto';
import type { Duplex } from 'node:stream';
import type { Socket } from 'node:net';

import type {
  ConnectionState,
  ConnectionStatus,
  Endpoint,
  ForwardDirection,
} from './model';

export interface ProxiedConnectionOptions {
  forwardId: string;
  direction: ForwardDirection;
  source: Endpoint;
  destination: Endpoint;
  connectionId?: string;
  onStateChange?: (status: ConnectionStatus, previous: ConnectionState) => void;
  /** Destroy the connection if it stays idle for this long. 0 disables. */
  idleTimeoutMs?: number;
}

const TERMINAL_STATES: ReadonlySet<ConnectionState> = new Set<ConnectionState>([
  'closed',
  'failed',
]);

export class ProxiedConnection {
  public readonly connectionId: string;
  public readonly forwardId: string;
  public readonly direction: ForwardDirection;
  public readonly source: Endpoint;
  public readonly destination: Endpoint;
  public readonly openedAtUnixMs: number;

  private state: ConnectionState = 'accepted';
  private closedAtUnixMs?: number;
  private bytesToTarget = 0;
  private bytesFromTarget = 0;
  private lastError?: string;

  private readonly onStateChange?: ProxiedConnectionOptions['onStateChange'];
  private readonly idleTimeoutMs: number;

  private inbound?: Socket | Duplex;
  private outbound?: Duplex;
  private tornDown = false;

  constructor(options: ProxiedConnectionOptions) {
    this.connectionId = options.connectionId ?? randomUUID();
    this.forwardId = options.forwardId;
    this.direction = options.direction;
    this.source = options.source;
    this.destination = options.destination;
    this.openedAtUnixMs = Date.now();
    this.onStateChange = options.onStateChange;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 0;
  }

  public getState(): ConnectionState {
    return this.state;
  }

  public isClosed(): boolean {
    return TERMINAL_STATES.has(this.state);
  }

  public getStatus(): ConnectionStatus {
    return {
      connectionId: this.connectionId,
      forwardId: this.forwardId,
      direction: this.direction,
      state: this.state,
      source: { ...this.source },
      destination: { ...this.destination },
      openedAtUnixMs: this.openedAtUnixMs,
      closedAtUnixMs: this.closedAtUnixMs,
      bytesToTarget: this.bytesToTarget,
      bytesFromTarget: this.bytesFromTarget,
      error: this.lastError,
    };
  }

  public markOpening(): void {
    this.transition('opening');
  }

  /**
   * Register the inbound stream before the outbound half exists.
   *
   * Channel open is asynchronous and can fail. Adopting the inbound stream first
   * means `fail()` and `close()` always destroy it, instead of leaving the peer
   * holding an open socket that will never carry data.
   */
  public adoptInbound(inbound: Socket | Duplex): void {
    if (this.tornDown) {
      this.destroyStream(inbound);
      return;
    }
    this.inbound = inbound;
  }

  /**
   * Attach both halves and start bidirectional flow.
   *
   * `inbound` is the stream the peer connected to; `outbound` is the stream that
   * reaches the destination. For a local forward that is (accepted TCP socket,
   * SSH channel). For a remote forward it is (SSH channel, outgoing TCP socket).
   */
  public attach(inbound: Socket | Duplex, outbound: Duplex): void {
    if (this.tornDown) {
      // A close arrived before the channel opened. Do not leak either side.
      this.destroyStream(inbound);
      this.destroyStream(outbound);
      return;
    }

    this.inbound = inbound;
    this.outbound = outbound;

    inbound.on('data', (chunk: Buffer) => {
      this.bytesToTarget += chunk.length;
    });
    outbound.on('data', (chunk: Buffer) => {
      this.bytesFromTarget += chunk.length;
    });

    // Client finished writing: half-close the target so a response can still
    // come back. Target gone (crash, RST, FIN): destroy the client socket.
    // A mere inbound.end() leaves allowHalfOpen listeners parked until the
    // client also FINs, which is the "socket stayed open 5000ms" failure.
    inbound.on('end', () => {
      this.transition('half_closed');
      if (this.outbound && !this.outbound.writableEnded) this.outbound.end();
    });
    outbound.on('end', () => {
      this.fail(new Error('target closed'), 'outbound');
    });

    inbound.on('error', (err: Error) => this.fail(err, 'inbound'));
    outbound.on('error', (err: Error) => this.fail(err, 'outbound'));

    inbound.on('close', () => this.close());
    outbound.on('close', () => this.close());

    if (this.idleTimeoutMs > 0 && typeof (inbound as Socket).setTimeout === 'function') {
      (inbound as Socket).setTimeout(this.idleTimeoutMs, () => {
        this.fail(new Error(`idle for ${this.idleTimeoutMs}ms`), 'inbound');
      });
    }

    inbound.pipe(outbound);
    outbound.pipe(inbound);

    this.transition('piped');
  }

  /** Record a failure and tear down. Safe to call repeatedly. */
  public fail(error: Error, side: 'inbound' | 'outbound' | 'channel' = 'channel'): void {
    if (this.isClosed()) return;
    this.lastError = `${side}: ${error.message}`;
    this.teardown();
    this.transition('failed');
  }

  /** Close cleanly. Safe to call repeatedly and from either side's handlers. */
  public close(): void {
    if (this.isClosed()) return;
    this.teardown();
    this.transition('closed');
  }

  private teardown(): void {
    if (this.tornDown) return;
    this.tornDown = true;
    this.closedAtUnixMs = Date.now();

    const { inbound, outbound } = this;

    if (inbound && outbound) {
      try {
        inbound.unpipe(outbound);
        outbound.unpipe(inbound);
      } catch {
        // unpipe on an already-destroyed stream is not actionable
      }
    }

    this.destroyStream(inbound);
    this.destroyStream(outbound);

    this.inbound = undefined;
    this.outbound = undefined;
  }

  private destroyStream(stream: Socket | Duplex | undefined): void {
    if (!stream) return;
    try {
      stream.removeAllListeners('data');
      if (!stream.destroyed) stream.destroy();
    } catch {
      // best effort
    }
  }

  private transition(next: ConnectionState): void {
    if (this.state === next) return;
    if (TERMINAL_STATES.has(this.state)) return;
    // half_closed must not overwrite a later terminal state
    if (next === 'half_closed' && this.state === 'accepted') return;
    const previous = this.state;
    this.state = next;
    this.onStateChange?.(this.getStatus(), previous);
  }
}
