/*
 * model.ts — TypeScript projection of proto/sshtunnel/v1/tunnel.proto
 *
 * Hand-maintained rather than generated so the public API stays idiomatic
 * TypeScript (string unions, optional fields, camelCase). The proto file
 * remains the cross-language source of truth; `assertModelParity` in the test
 * suite checks that every proto enum value has a TypeScript counterpart.
 *
 * License: MIT
 */

export const MODEL_VERSION = 'sshtunnel.v1';

/** A TCP endpoint. `host` is an IP literal or DNS name, never a URL. */
export interface Endpoint {
  host: string;
  port: number;
}

export const CREDENTIAL_SOURCES = ['file', 'env', 'inline', 'agent', 'callback'] as const;
export type CredentialSource = (typeof CREDENTIAL_SOURCES)[number];

/** Indirect reference to secret material; the model never carries the secret. */
export interface CredentialRef {
  source: CredentialSource;
  value?: string;
}

/**
 * Port authorization is an explicit caller policy. Local listen ports and
 * remote target ports are separate decisions: one governs what this process may
 * bind, the other governs what the SSH peer is asked to reach.
 */
export interface PortPolicy {
  allowedPrivilegedPorts?: readonly number[];
  allowedLocalListenPorts?: readonly number[];
  allowedRemoteTargetPorts?: readonly number[];
  allowedRemoteHosts?: readonly string[];
}

/** ssh -L : listen here, deliver to a host reachable from the SSH peer. */
export interface LocalForward {
  id?: string;
  listen: Endpoint;
  target: Endpoint;
  exclusive?: boolean;
  maxConnections?: number;
}

/** ssh -R : the peer listens, connections are delivered to a host reachable here. */
export interface RemoteForward {
  id?: string;
  /** Bound on the SSH peer. `port: 0` asks the peer to assign one. */
  bind: Endpoint;
  /** Resolved by this machine. */
  target: Endpoint;
  maxConnections?: number;
}

export const REACHABILITY_VALUES = ['direct', 'zrok', 'ngrok', 'custom'] as const;
export type Reachability = (typeof REACHABILITY_VALUES)[number];

/**
 * How to reach an SSH listener that already exists. This library never
 * provisions a relay; `reachability` is documentation metadata only.
 */
export interface SshTransport {
  endpoint: Endpoint;
  username: string;
  privateKey?: CredentialRef;
  passphrase?: CredentialRef;
  password?: CredentialRef;
  keepaliveIntervalMs?: number;
  keepaliveCountMax?: number;
  readyTimeoutMs?: number;
  /** `sha256:...` values. Empty or omitted accepts any host key. */
  hostKeyFingerprints?: readonly string[];
  reachability?: Reachability;
}

export interface ReconnectPolicy {
  enabled?: boolean;
  /** 0 means unlimited. */
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffMultiplier?: number;
  /** 0.0 .. 1.0 */
  jitterRatio?: number;
}

export interface TunnelConfig {
  id?: string;
  label?: string;
  transport: SshTransport;
  portPolicy?: PortPolicy;
  reconnect?: ReconnectPolicy;
  localForwards?: readonly LocalForward[];
  remoteForwards?: readonly RemoteForward[];
  metadata?: Record<string, string>;
}

export const TUNNEL_STATES = [
  'idle',
  'connecting',
  'ready',
  'reconnecting',
  'closing',
  'closed',
  'failed',
] as const;
export type TunnelState = (typeof TUNNEL_STATES)[number];

export const FORWARD_STATES = [
  'pending',
  'opening',
  'active',
  'degraded',
  'closing',
  'closed',
  'failed',
] as const;
export type ForwardState = (typeof FORWARD_STATES)[number];

export const CONNECTION_STATES = [
  'accepted',
  'opening',
  'piped',
  'half_closed',
  'closed',
  'failed',
] as const;
export type ConnectionState = (typeof CONNECTION_STATES)[number];

export const FORWARD_DIRECTIONS = ['local', 'remote'] as const;
export type ForwardDirection = (typeof FORWARD_DIRECTIONS)[number];

export interface ConnectionStatus {
  connectionId: string;
  forwardId: string;
  direction: ForwardDirection;
  state: ConnectionState;
  source: Endpoint;
  destination: Endpoint;
  openedAtUnixMs: number;
  closedAtUnixMs?: number;
  bytesToTarget: number;
  bytesFromTarget: number;
  error?: string;
}

export interface ForwardStatus {
  forwardId: string;
  direction: ForwardDirection;
  state: ForwardState;
  listen: Endpoint;
  target: Endpoint;
  assignedPort?: number;
  activeConnections: number;
  totalConnections: number;
  error?: string;
}

export interface TunnelStatus {
  tunnelId: string;
  state: TunnelState;
  endpoint: Endpoint;
  reconnectAttempt: number;
  connectedAtUnixMs?: number;
  forwards: ForwardStatus[];
  error?: string;
}

export const DEFAULT_RECONNECT_POLICY: Required<ReconnectPolicy> = {
  enabled: true,
  maxAttempts: 10,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
  jitterRatio: 0.2,
};

export const DEFAULT_KEEPALIVE_INTERVAL_MS = 10000;
export const DEFAULT_KEEPALIVE_COUNT_MAX = 3;
export const DEFAULT_READY_TIMEOUT_MS = 20000;
