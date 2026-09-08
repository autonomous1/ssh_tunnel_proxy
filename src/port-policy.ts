/*
 * port-policy.ts — pure port authorization.
 *
 * No sockets, no SSH, no filesystem, no network. Everything here is a total
 * function over plain values, which is what makes it cheap to unit test.
 *
 * License: MIT
 */

import { TunnelError } from './errors';
import type { PortPolicy } from './model';

export const MIN_PORT = 1;
export const MAX_PORT = 65535;
export const FIRST_UNPRIVILEGED_PORT = 1024;

/** Which side of a forward a port belongs to. */
export type PortRole = 'local-listen' | 'remote-target' | 'remote-bind';

/**
 * True when `port` is a syntactically valid TCP port number.
 *
 * Stricter than the v1 `validate_port_number`: fractional values, NaN and
 * numbers parsed out of strings such as `"80abc"` are rejected rather than
 * silently truncated.
 */
export function isValidPort(port: unknown): port is number {
  return (
    typeof port === 'number' &&
    Number.isInteger(port) &&
    port >= MIN_PORT &&
    port <= MAX_PORT
  );
}

/**
 * Parse a port from text with no coercion surprises.
 * Returns `undefined` for anything that is not a bare decimal integer.
 */
export function parsePort(text: string): number | undefined {
  if (typeof text !== 'string') return undefined;
  if (!/^[0-9]{1,5}$/.test(text)) return undefined;
  const port = Number(text);
  return isValidPort(port) ? port : undefined;
}

/** `port: 0` is legal only for a remote bind, where it means "peer assigns". */
export function isValidBindPort(port: unknown): port is number {
  return port === 0 || isValidPort(port);
}

function inList(list: readonly number[] | undefined, port: number): boolean {
  return Array.isArray(list) && list.includes(port);
}

export interface PortCheckResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Evaluate a port against a policy for a given role.
 *
 * Policy semantics, in order:
 *   1. The port must be a valid TCP port (a remote bind may also be 0).
 *   2. A privileged port (< 1024) requires an explicit allowlist entry.
 *   3. If a role-specific allowlist is non-empty, the port must appear in it.
 *
 * An absent or empty policy therefore permits any unprivileged port and no
 * privileged port.
 */
export function checkPort(
  port: unknown,
  role: PortRole,
  policy: PortPolicy = {},
): PortCheckResult {
  const allowZero = role === 'remote-bind';

  if (allowZero ? !isValidBindPort(port) : !isValidPort(port)) {
    return {
      allowed: false,
      reason: `${String(port)} is not a valid TCP port (${MIN_PORT}-${MAX_PORT}${allowZero ? ', or 0 for peer-assigned' : ''})`,
    };
  }

  const value = port as number;

  if (value !== 0 && value < FIRST_UNPRIVILEGED_PORT) {
    if (!inList(policy.allowedPrivilegedPorts, value)) {
      return {
        allowed: false,
        reason: `privileged port ${value} requires an explicit allowedPrivilegedPorts entry`,
      };
    }
  }

  const roleList =
    role === 'local-listen'
      ? policy.allowedLocalListenPorts
      : role === 'remote-target'
        ? policy.allowedRemoteTargetPorts
        : undefined;

  if (roleList && roleList.length > 0 && !roleList.includes(value)) {
    return {
      allowed: false,
      reason: `port ${value} is not in the ${role} allowlist`,
    };
  }

  return { allowed: true };
}

/** Throwing form of {@link checkPort}. */
export function assertPortAllowed(
  port: unknown,
  role: PortRole,
  policy: PortPolicy = {},
  forwardId?: string,
): number {
  const result = checkPort(port, role, policy);
  if (!result.allowed) {
    throw new TunnelError('PORT_NOT_PERMITTED', `Rejected ${role} port: ${result.reason}`, {
      forwardId,
    });
  }
  return port as number;
}

/** A hostname or IP literal, syntactically. Does not resolve anything. */
export function isValidHost(host: unknown): host is string {
  if (typeof host !== 'string') return false;
  const value = host.trim();
  if (value.length === 0 || value.length > 255) return false;
  if (value !== host) return false;
  if (value.includes('/') || value.includes(' ')) return false;
  // Bracketed or bare IPv6
  if (value.startsWith('[') && value.endsWith(']')) return value.length > 2;
  if (/^[0-9a-fA-F:]+$/.test(value) && value.includes(':')) return true;
  return /^[A-Za-z0-9_]([A-Za-z0-9_-]*[A-Za-z0-9_])?(\.[A-Za-z0-9_]([A-Za-z0-9_-]*[A-Za-z0-9_])?)*$/.test(
    value,
  );
}

export function assertHostAllowed(
  host: unknown,
  policy: PortPolicy = {},
  forwardId?: string,
): string {
  if (!isValidHost(host)) {
    throw new TunnelError('INVALID_FORWARD_SPEC', `Invalid host: ${JSON.stringify(host)}`, {
      forwardId,
    });
  }
  const allowed = policy.allowedRemoteHosts;
  if (allowed && allowed.length > 0 && !allowed.includes(host)) {
    throw new TunnelError('HOST_NOT_PERMITTED', `Host ${host} is not in allowedRemoteHosts`, {
      forwardId,
    });
  }
  return host;
}
