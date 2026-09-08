/*
 * bridge.ts — the narrow surface a forward handle needs from its tunnel.
 *
 * Forward handles never reach into the tunnel, and the tunnel never reaches into
 * a handle's sockets. Everything crosses this interface, which keeps the forward
 * logic unit-testable against a fake transport.
 *
 * License: MIT
 */

import type { Client } from 'ssh2';

import type { TunnelError } from './errors';
import type {
  ConnectionState,
  ConnectionStatus,
  ForwardState,
  ForwardStatus,
} from './model';

export interface TransportBridge {
  /** The live SSH client, or throw TRANSPORT_NOT_READY. */
  requireClient(forwardId: string): Client;
  /** The live SSH client, or undefined when the transport is down. */
  peekClient(): Client | undefined;
  onConnectionChanged(status: ConnectionStatus, previous: ConnectionState): void;
  onForwardChanged(status: ForwardStatus, previous: ForwardState): void;
  onError(error: TunnelError): void;
  debug(message: string, ...args: unknown[]): void;
}
