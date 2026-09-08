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
