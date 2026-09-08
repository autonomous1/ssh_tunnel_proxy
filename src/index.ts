/*
 * ssh_tunnel_proxy v2
 *
 * Programmatic local and reverse TCP port forwarding over SSH for Node.js,
 * built for services and devices that only have an outbound SSH transport.
 *
 * Author: Autonomous
 * First release: 1-29-2023
 * License: MIT
 */

export { SSHTunnel } from './tunnel';
export type { SSHTunnelOptions, TunnelEvents } from './tunnel';

export { LocalForwardHandle } from './local-forward';
export { RemoteForwardHandle } from './remote-forward';
export { ProxiedConnection } from './connection';
export type { ProxiedConnectionOptions } from './connection';
export type { TransportBridge } from './bridge';

export { TUNNEL_ERROR_CODES, TunnelError, isTunnelError, asTunnelError } from './errors';
export type { TunnelErrorCode, TunnelErrorDetails } from './errors';

export {
  DEFAULT_LISTEN_ADDRESS,
  DEFAULT_REMOTE_BIND_ADDRESS,
  describeLocalForward,
  describeRemoteForward,
  parseAndValidateLocalForward,
  parseAndValidateRemoteForward,
  parseLocalForwardSpec,
  parseRemoteForwardSpec,
  validateLocalForward,
  validateRemoteForward,
} from './forward-spec';

export {
  FIRST_UNPRIVILEGED_PORT,
  MAX_PORT,
  MIN_PORT,
  assertHostAllowed,
  assertPortAllowed,
  checkPort,
  isValidBindPort,
  isValidHost,
  isValidPort,
  parsePort,
} from './port-policy';
export type { PortCheckResult, PortRole } from './port-policy';

export { credential, expandHome, resolveAgentSocket, resolveCredential } from './credentials';
export type { CredentialResolver, ResolveOptions } from './credentials';

export {
  CONNECTION_STATES,
  CREDENTIAL_SOURCES,
  FORWARD_DIRECTIONS,
  FORWARD_STATES,
  REACHABILITY_VALUES,
  TUNNEL_STATES,
  DEFAULT_KEEPALIVE_COUNT_MAX,
  DEFAULT_KEEPALIVE_INTERVAL_MS,
  DEFAULT_READY_TIMEOUT_MS,
  DEFAULT_RECONNECT_POLICY,
  MODEL_VERSION,
} from './model';
export type {
  ConnectionState,
  ConnectionStatus,
  CredentialRef,
  CredentialSource,
  Endpoint,
  ForwardDirection,
  ForwardState,
  ForwardStatus,
  LocalForward,
  PortPolicy,
  Reachability,
  ReconnectPolicy,
  RemoteForward,
  SshTransport,
  TunnelConfig,
  TunnelState,
  TunnelStatus,
} from './model';

// v1 compatibility. New code should use SSHTunnel.
export {
  SSHTunnelProxy,
  legacyConfigToTunnelConfig,
  whitelistToPortPolicy,
} from './legacy';
export type { LegacySSHConfig } from './legacy';
