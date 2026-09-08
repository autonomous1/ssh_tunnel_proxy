/*
 * credentials.ts — resolve a CredentialRef to bytes at connect time.
 *
 * This replaces the v1 keychain integration. The package no longer generates,
 * stores, or derives key material: it reads a key the operator already manages
 * with ssh-keygen, an agent, or a secret manager. `sshpk` and `keytar` are gone
 * from the dependency list as a result.
 *
 * License: MIT
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { TunnelError, asTunnelError } from './errors';
import type { CredentialRef } from './model';

/** Host-supplied resolver for `{ source: 'callback' }` refs. */
export type CredentialResolver = (ref: CredentialRef) => string | Buffer | Promise<string | Buffer>;

export function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}

export interface ResolveOptions {
  resolver?: CredentialResolver;
  label?: string;
}

/**
 * Resolve a credential reference. Returns `undefined` when `ref` is undefined so
 * callers can pass optional fields straight through.
 */
export async function resolveCredential(
  ref: CredentialRef | undefined,
  options: ResolveOptions = {},
): Promise<Buffer | string | undefined> {
  if (!ref) return undefined;
  const label = options.label ?? 'credential';

  switch (ref.source) {
    case 'inline': {
      if (!ref.value) {
        throw new TunnelError('CREDENTIAL_UNRESOLVED', `Inline ${label} has no value`);
      }
      return ref.value;
    }

    case 'env': {
      if (!ref.value) {
        throw new TunnelError('CREDENTIAL_UNRESOLVED', `Env ${label} has no variable name`);
      }
      const value = process.env[ref.value];
      if (value === undefined || value.length === 0) {
        throw new TunnelError(
          'CREDENTIAL_UNRESOLVED',
          `Environment variable ${ref.value} for ${label} is unset or empty`,
        );
      }
      return value;
    }

    case 'file': {
      if (!ref.value) {
        throw new TunnelError('CREDENTIAL_UNRESOLVED', `File ${label} has no path`);
      }
      const path = expandHome(ref.value);
      if (!isAbsolute(path)) {
        throw new TunnelError(
          'CREDENTIAL_UNRESOLVED',
          `Path for ${label} must be absolute or start with "~": ${ref.value}`,
        );
      }
      try {
        return readFileSync(path);
      } catch (cause) {
        throw asTunnelError('CREDENTIAL_UNRESOLVED', `Cannot read ${label} from ${path}`, cause);
      }
    }

    case 'agent': {
      // The agent path is handled by the transport, not read as bytes.
      return undefined;
    }

    case 'callback': {
      if (!options.resolver) {
        throw new TunnelError(
          'CREDENTIAL_UNRESOLVED',
          `${label} uses source "callback" but no credentialResolver was supplied`,
        );
      }
      try {
        return await options.resolver(ref);
      } catch (cause) {
        throw asTunnelError('CREDENTIAL_UNRESOLVED', `Resolver failed for ${label}`, cause);
      }
    }

    default: {
      throw new TunnelError(
        'CREDENTIAL_UNRESOLVED',
        `Unsupported credential source ${JSON.stringify((ref as CredentialRef).source)}`,
      );
    }
  }
}

/** Convenience constructors so callers rarely write the object literal. */
export const credential = {
  file: (path: string): CredentialRef => ({ source: 'file', value: path }),
  env: (name: string): CredentialRef => ({ source: 'env', value: name }),
  inline: (value: string): CredentialRef => ({ source: 'inline', value }),
  agent: (socketPath?: string): CredentialRef => ({ source: 'agent', value: socketPath }),
  callback: (name?: string): CredentialRef => ({ source: 'callback', value: name }),
};

/** Resolve the agent socket path for an `agent` credential ref. */
export function resolveAgentSocket(ref: CredentialRef | undefined): string | undefined {
  if (!ref || ref.source !== 'agent') return undefined;
  return ref.value ?? process.env.SSH_AUTH_SOCK;
}
