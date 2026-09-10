/*
 * errors.ts — stable error taxonomy.
 *
 * Every failure surfaced by this package carries a machine-readable `code` that
 * mirrors sshtunnel.v1.TunnelEvent.ErrorRaised.Code. Callers branch on the code,
 * never on the message text.
 *
 * License: MIT
 */

export const TUNNEL_ERROR_CODES = [
  'INVALID_FORWARD_SPEC',
  'PORT_NOT_PERMITTED',
  'HOST_NOT_PERMITTED',
  'TRANSPORT_NOT_READY',
  'AUTH_FAILED',
  'LISTEN_FAILED',
  'REMOTE_BIND_FAILED',
  'CHANNEL_OPEN_FAILED',
  'TARGET_UNREACHABLE',
  'DUPLICATE_FORWARD_ID',
  'UNKNOWN_FORWARD',
  'CONNECTION_LIMIT',
  'RECONNECT_EXHAUSTED',
  'CREDENTIAL_UNRESOLVED',
] as const;

export type TunnelErrorCode = (typeof TUNNEL_ERROR_CODES)[number];

export interface TunnelErrorDetails {
  forwardId?: string;
  connectionId?: string;
  cause?: unknown;
}

export class TunnelError extends Error {
  public readonly code: TunnelErrorCode;
  public readonly forwardId?: string;
  public readonly connectionId?: string;
  public override readonly cause?: unknown;

  constructor(code: TunnelErrorCode, message: string, details: TunnelErrorDetails = {}) {
    super(message);
    this.name = 'TunnelError';
    this.code = code;
    this.forwardId = details.forwardId;
    this.connectionId = details.connectionId;
    this.cause = details.cause;
    Object.setPrototypeOf(this, TunnelError.prototype);
  }

  public toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      forwardId: this.forwardId,
      connectionId: this.connectionId,
    };
  }
}

export function isTunnelError(value: unknown): value is TunnelError {
  return value instanceof TunnelError;
}

/** Wrap an unknown thrown value in a TunnelError without losing the original. */
export function asTunnelError(
  code: TunnelErrorCode,
  message: string,
  cause: unknown,
  details: Omit<TunnelErrorDetails, 'cause'> = {},
): TunnelError {
  const suffix = cause instanceof Error ? `: ${cause.message}` : cause ? `: ${String(cause)}` : '';
  return new TunnelError(code, `${message}${suffix}`, { ...details, cause });
}

/**
 * Classify a failed `forwardOut` / channel open.
 *
 * Dest-refuse (nothing listening on the far target, or a TCP connect
 * failure) is `TARGET_UNREACHABLE`. The SSH peer refusing the channel
 * type or the session being down is `CHANNEL_OPEN_FAILED` /
 * `TRANSPORT_NOT_READY`. Callers and simulators can branch on the code
 * without parsing ssh2 message text.
 */
export function classifyChannelOpenFailure(cause: unknown): TunnelErrorCode {
  if (cause && typeof cause === 'object') {
    const record = cause as {
      code?: string;
      level?: string;
      reason?: string | number;
      message?: string;
    };
    const nodeCode = String(record.code ?? '').toUpperCase();
    if (
      nodeCode === 'ECONNREFUSED' ||
      nodeCode === 'ENOTFOUND' ||
      nodeCode === 'EHOSTUNREACH' ||
      nodeCode === 'ENETUNREACH' ||
      nodeCode === 'ETIMEDOUT' ||
      nodeCode === 'ECONNRESET'
    ) {
      return 'TARGET_UNREACHABLE';
    }
    // ssh2 ChannelOpenError.reason is the SSH2 numeric or a string.
    const reason = String(record.reason ?? '').toLowerCase();
    if (
      reason.includes('connect') ||
      reason === '2' ||
      reason === 'ssh_open_connect_failed'
    ) {
      return 'TARGET_UNREACHABLE';
    }
    if (record.level === 'client-timeout') return 'CHANNEL_OPEN_FAILED';
    const message = String(record.message ?? '').toLowerCase();
    if (
      message.includes('connect failed') ||
      message.includes('econnrefused') ||
      message.includes('connection refused') ||
      message.includes('no route') ||
      message.includes('host unreachable')
    ) {
      return 'TARGET_UNREACHABLE';
    }
    if (
      message.includes('not connected') ||
      message.includes('no response') ||
      nodeCode === 'EPIPE'
    ) {
      return 'TRANSPORT_NOT_READY';
    }
  }
  return 'CHANNEL_OPEN_FAILED';
}
