/*
 * forward-spec.ts — pure parsing of the OpenSSH-style forward strings.
 *
 * The v1 configuration syntax is preserved so existing config.json files keep
 * working, but the parsing rules are now explicit: field counts are checked
 * before destructuring, and ports must be bare decimal integers.
 *
 * Local forward (ssh -L):
 *   "localPort:remoteHost:remotePort"
 *   "bindAddress:localPort:remoteHost:remotePort"
 *
 * Remote forward (ssh -R):
 *   "bindPort:targetHost:targetPort"
 *   "bindAddress:bindPort:targetHost:targetPort"
 *
 * Note the v1 3-field remote form was "localPort:host:remotePort" with the
 * fields in an order that read backwards relative to OpenSSH. See MIGRATION.md;
 * `parseRemoteForwardSpec` documents the mapping it applies.
 *
 * License: MIT
 */

import { TunnelError } from './errors';
import type { LocalForward, PortPolicy, RemoteForward } from './model';
import { assertHostAllowed, assertPortAllowed, isValidBindPort, parsePort } from './port-policy';

export const DEFAULT_LISTEN_ADDRESS = '127.0.0.1';
export const DEFAULT_REMOTE_BIND_ADDRESS = 'localhost';

const LOCAL_FORWARD_SHAPE = 'localPort:remoteHost:remotePort or bindAddress:localPort:remoteHost:remotePort';
const REMOTE_FORWARD_SHAPE = 'bindPort:targetHost:targetPort or bindAddress:bindPort:targetHost:targetPort';

function invalid(spec: string, shape: string, detail?: string): TunnelError {
  const suffix = detail ? ` (${detail})` : '';
  return new TunnelError(
    'INVALID_FORWARD_SPEC',
    `Invalid forward "${spec}"; expected ${shape}${suffix}`,
  );
}

function splitSpec(spec: unknown, shape: string): string[] {
  if (typeof spec !== 'string' || spec.trim().length === 0) {
    throw new TunnelError(
      'INVALID_FORWARD_SPEC',
      `Invalid forward ${JSON.stringify(spec)}; expected ${shape}`,
    );
  }
  const fields = spec.split(':');
  if (fields.length < 3 || fields.length > 4) {
    throw invalid(spec, shape, `got ${fields.length} colon-separated fields`);
  }
  return fields;
}

function requirePort(spec: string, text: string, shape: string, label: string): number {
  const port = parsePort(text);
  if (port === undefined) {
    throw invalid(spec, shape, `${label} "${text}" is not a decimal port in 1-65535`);
  }
  return port;
}

/**
 * Parse a local-forward string into a structured {@link LocalForward}.
 * Syntax only — call {@link validateLocalForward} to apply a {@link PortPolicy}.
 */
export function parseLocalForwardSpec(spec: string): LocalForward {
  const fields = splitSpec(spec, LOCAL_FORWARD_SHAPE);

  const [listenHost, listenPortText, targetHostText, targetPortText] =
    fields.length === 4
      ? (fields as [string, string, string, string])
      : ([DEFAULT_LISTEN_ADDRESS, fields[0], fields[1], fields[2]] as [
          string,
          string,
          string,
          string,
        ]);

  if (listenHost.trim().length === 0) {
    throw invalid(spec, LOCAL_FORWARD_SHAPE, 'bind address is empty');
  }
  if (targetHostText.trim().length === 0) {
    throw invalid(spec, LOCAL_FORWARD_SHAPE, 'remote host is required');
  }

  return {
    id: spec,
    listen: {
      host: listenHost,
      port: requirePort(spec, listenPortText, LOCAL_FORWARD_SHAPE, 'local listen port'),
    },
    target: {
      host: targetHostText,
      port: requirePort(spec, targetPortText, LOCAL_FORWARD_SHAPE, 'remote target port'),
    },
  };
}

/**
 * Parse a remote-forward string into a structured {@link RemoteForward}.
 *
 * Field mapping, matching v1 behaviour:
 *   3 fields: bindPort : targetHost : targetPort, bind address defaults to
 *             "localhost" on the peer.
 *   4 fields: bindAddress : bindPort : targetHost : targetPort.
 *
 * A bind port of 0 asks the SSH peer to assign one; the assigned value is
 * reported in ForwardStatus.assignedPort.
 */
export function parseRemoteForwardSpec(spec: string): RemoteForward {
  const fields = splitSpec(spec, REMOTE_FORWARD_SHAPE);

  const [bindHost, bindPortText, targetHostText, targetPortText] =
    fields.length === 4
      ? (fields as [string, string, string, string])
      : ([DEFAULT_REMOTE_BIND_ADDRESS, fields[0], fields[1], fields[2]] as [
          string,
          string,
          string,
          string,
        ]);

  if (bindHost.trim().length === 0) {
    throw invalid(spec, REMOTE_FORWARD_SHAPE, 'bind address is empty');
  }
  if (targetHostText.trim().length === 0) {
    throw invalid(spec, REMOTE_FORWARD_SHAPE, 'target host is required');
  }

  const bindPort = bindPortText === '0' ? 0 : parsePort(bindPortText);
  if (!isValidBindPort(bindPort)) {
    throw invalid(spec, REMOTE_FORWARD_SHAPE, `bind port "${bindPortText}" is not 0-65535`);
  }

  return {
    id: spec,
    bind: { host: bindHost, port: bindPort as number },
    target: {
      host: targetHostText,
      port: requirePort(spec, targetPortText, REMOTE_FORWARD_SHAPE, 'target port'),
    },
  };
}

/**
 * Apply a {@link PortPolicy} to a structured local forward and return a
 * normalized copy. Throws a {@link TunnelError} on the first violation.
 */
export function validateLocalForward(
  forward: LocalForward,
  policy: PortPolicy = {},
): Required<Pick<LocalForward, 'id' | 'listen' | 'target'>> & LocalForward {
  const id = forward.id ?? describeLocalForward(forward);
  const listenHost = forward.listen?.host ?? DEFAULT_LISTEN_ADDRESS;

  assertHostAllowed(listenHost, {}, id);
  const loopbackListen = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
  if (!loopbackListen.has(listenHost)) {
    throw new TunnelError(
      'HOST_NOT_PERMITTED',
      `Local listen host ${listenHost} is not loopback; bind 127.0.0.1 or ::1`,
      { forwardId: id },
    );
  }
  assertPortAllowed(forward.listen?.port, 'local-listen', policy, id);
  assertHostAllowed(forward.target?.host, policy, id);
  assertPortAllowed(forward.target?.port, 'remote-target', policy, id);

  return {
    ...forward,
    id,
    listen: { host: listenHost, port: forward.listen.port },
    target: { host: forward.target.host, port: forward.target.port },
  };
}

/** Apply a {@link PortPolicy} to a structured remote forward. */
export function validateRemoteForward(
  forward: RemoteForward,
  policy: PortPolicy = {},
): Required<Pick<RemoteForward, 'id' | 'bind' | 'target'>> & RemoteForward {
  const id = forward.id ?? describeRemoteForward(forward);
  const bindHost = forward.bind?.host ?? DEFAULT_REMOTE_BIND_ADDRESS;

  assertHostAllowed(bindHost, {}, id);
  assertPortAllowed(forward.bind?.port, 'remote-bind', policy, id);
  assertHostAllowed(forward.target?.host, {}, id);
  assertPortAllowed(forward.target?.port, 'local-listen', policy, id);

  return {
    ...forward,
    id,
    bind: { host: bindHost, port: forward.bind.port },
    target: { host: forward.target.host, port: forward.target.port },
  };
}

/** Parse and validate in one step. */
export function parseAndValidateLocalForward(spec: string, policy: PortPolicy = {}): LocalForward {
  return validateLocalForward(parseLocalForwardSpec(spec), policy);
}

/** Parse and validate in one step. */
export function parseAndValidateRemoteForward(spec: string, policy: PortPolicy = {}): RemoteForward {
  return validateRemoteForward(parseRemoteForwardSpec(spec), policy);
}

export function describeLocalForward(forward: LocalForward): string {
  const host = forward.listen?.host ?? DEFAULT_LISTEN_ADDRESS;
  return `L:${host}:${forward.listen?.port}->${forward.target?.host}:${forward.target?.port}`;
}

export function describeRemoteForward(forward: RemoteForward): string {
  const host = forward.bind?.host ?? DEFAULT_REMOTE_BIND_ADDRESS;
  return `R:${host}:${forward.bind?.port}->${forward.target?.host}:${forward.target?.port}`;
}
