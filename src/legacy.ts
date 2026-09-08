/*
 * legacy.ts — v1 compatibility surface.
 *
 * Existing callers keep `proxy_ports` / `remote_ports` string arrays, the
 * `whitelist` object, and the `ssh_tunnel_ready` / `status` events. Everything is
 * translated into the v2 model and executed by SSHTunnel.
 *
 * Options that were removed rather than renamed throw immediately with a pointer
 * to MIGRATION.md, so nobody silently loses key management or ngrok resolution.
 *
 * License: MIT
 */

import { EventEmitter } from 'node:events';
import type { Writable } from 'node:stream';
import type { Client } from 'ssh2';

import { credential } from './credentials';
import { TunnelError } from './errors';
import { parseAndValidateLocalForward } from './forward-spec';
import type { ForwardStatus, PortPolicy, TunnelConfig, TunnelStatus } from './model';
import { checkPort } from './port-policy';
import { SSHTunnel } from './tunnel';

/** The v1 configuration object, minus the options that v2 removed. */
export interface LegacySSHConfig {
  hostname?: string;
  username: string;
  password?: string;
  host?: string;
  port?: string | number;
  proxy_ports?: string[];
  remote_ports?: string[];
  private_key?: string | null;
  private_key_filename?: string | null;
  whitelist?: Record<string, unknown> | null;
  keepaliveInterval?: number;
  server_name?: string;
  disabled?: boolean;

  /** Commands to run once the tunnel is up, as in v1. */
  exec?: string[];

  // Removed in v2 — present only so the shim can produce a useful error.
  ngrok_api?: string;
  service_name?: string;
  shell?: boolean;
}

const REMOVED_OPTIONS: Array<[keyof LegacySSHConfig, string]> = [
  ['ngrok_api', 'ngrok resolution was removed; point transport.endpoint at an existing SSH listener'],
  ['service_name', 'system-keychain key storage was removed; use transport.privateKey with a file/env/callback ref'],
  ['shell', 'interactive shell support was removed; use a terminal client'],
];

export function whitelistToPortPolicy(whitelist?: Record<string, unknown> | null): PortPolicy {
  if (!whitelist) return {};
  const ports = Object.keys(whitelist)
    .map((key) => Number(key))
    .filter((port) => Number.isInteger(port) && port > 0 && port < 1024);
  return ports.length > 0 ? { allowedPrivilegedPorts: ports } : {};
}

/** Translate a v1 config into a v2 {@link TunnelConfig}. */
export function legacyConfigToTunnelConfig(
  opts: LegacySSHConfig,
  whitelist?: Record<string, unknown> | null,
): TunnelConfig {
  for (const [key, advice] of REMOVED_OPTIONS) {
    if (opts[key] !== undefined && opts[key] !== null && opts[key] !== false) {
      throw new TunnelError(
        'INVALID_FORWARD_SPEC',
        `Option "${String(key)}" is no longer supported in ssh_tunnel_proxy v2: ${advice}. See MIGRATION.md.`,
      );
    }
  }

  const host = opts.host ?? opts.hostname;
  if (!host) {
    throw new TunnelError('INVALID_FORWARD_SPEC', 'A host (or hostname) is required');
  }

  const port = Number(opts.port ?? 22);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new TunnelError('INVALID_FORWARD_SPEC', `Invalid SSH port: ${String(opts.port)}`);
  }

  const config: TunnelConfig = {
    id: opts.server_name ?? `${host}:${port}`,
    transport: {
      endpoint: { host, port },
      username: opts.username,
      keepaliveIntervalMs: opts.keepaliveInterval,
    },
    portPolicy: whitelistToPortPolicy(whitelist ?? opts.whitelist),
  };

  // proxy_ports / remote_ports stay as spec strings and are handed to
  // SSHTunnel.addLocalForwards / addRemoteForwards after connect, so the v1
  // string syntax has exactly one parser.

  if (opts.private_key_filename) {
    config.transport.privateKey = credential.file(opts.private_key_filename);
  } else if (opts.private_key) {
    config.transport.privateKey = credential.inline(opts.private_key);
  }
  if (opts.password && opts.password.length > 0) {
    config.transport.password = credential.inline(opts.password);
  }

  return config;
}

/**
 * Drop-in replacement for the v1 class, implemented on top of {@link SSHTunnel}.
 *
 * New code should use SSHTunnel directly: it exposes forward ids, per-connection
 * state, atomic multi-forward setup, and typed lifecycle events, none of which
 * the v1 method names can express.
 */
export class SSHTunnelProxy extends EventEmitter {
  public debug_en = false;
  public debug_ssh = false;

  private tunnel?: SSHTunnel;

  /** Kept for source compatibility; port policy is now explicit. */
  public validate_port_number(port: number, whitelist?: Record<string, unknown> | null): boolean {
    return checkPort(port, 'remote-target', whitelistToPortPolicy(whitelist)).allowed;
  }

  /** Kept for source compatibility; throws a TunnelError on the first bad spec. */
  public validate_local_forward(
    proxy_ports?: string[] | null,
    whitelist?: Record<string, unknown> | null,
  ): boolean {
    if (!proxy_ports) return true;
    const policy = whitelistToPortPolicy(whitelist);
    for (const spec of proxy_ports) {
      parseAndValidateLocalForward(spec, policy);
    }
    return true;
  }

  private announcedReady = false;

  public async connectSSH(
    opts: LegacySSHConfig,
    whitelist?: Record<string, unknown> | null,
  ): Promise<void> {
    const config = legacyConfigToTunnelConfig(opts, whitelist);
    const tunnel = new SSHTunnel(config, { debugSsh: this.debug_ssh });
    this.tunnel = tunnel;

    tunnel.on('debug', (message, ...args) => {
      if (this.debug_en) console.log(message, ...args);
      this.emit('debug', message, ...args);
    });
    tunnel.on('error', (error) => this.emit('error', error));
    tunnel.on('ready', (status: TunnelStatus) => {
      this.emit('status', '', 'ready', `${status.endpoint.host}:${status.endpoint.port}`);
      // v1 signalled readiness once the forwards were usable. On the first connect
      // that happens below, after the ports are set up; on a reconnect the forwards
      // are re-established before `ready`, so signal again here.
      if (this.announcedReady) this.emit('ssh_tunnel_ready', {});
    });
    tunnel.on('close', () => this.emit('status', '', 'closed', ''));

    await tunnel.connect();

    if (opts.proxy_ports && opts.proxy_ports.length > 0) {
      await tunnel.addLocalForwards(opts.proxy_ports);
    }
    if (opts.remote_ports && opts.remote_ports.length > 0) {
      await tunnel.addRemoteForwards(opts.remote_ports);
    }

    this.announcedReady = true;
    this.emit('ssh_tunnel_ready', {});

    // v1 ran `opts.exec` commands once the tunnel was up.
    for (const cmd of opts.exec ?? []) {
      await this.execCmd(cmd);
    }
  }

  /**
   * v1 returned nothing here. v2 returns the resulting forward statuses, which is
   * a superset: existing callers that ignore the return value are unaffected, and
   * new code can read back the port a `0` bind was actually given.
   */
  public async setupProxyPorts(proxy_ports: string[]): Promise<ForwardStatus[]> {
    return this.requireTunnel().addLocalForwards(proxy_ports);
  }

  public async setupRemotePorts(remote_ports: string[]): Promise<ForwardStatus[]> {
    return this.requireTunnel().addRemoteForwards(remote_ports);
  }

  /**
   * Like v1: with no streams supplied the output goes to this process's stdout and
   * stderr. Unlike v1, the collected stdout is also returned.
   */
  public async execCmd(cmd: string, dataStream?: Writable, errStream?: Writable): Promise<string> {
    const result = await this.requireTunnel().exec(cmd, {
      stdout: dataStream ?? process.stdout,
      stderr: errStream ?? process.stderr,
    });
    return result.stdout;
  }

  public getStatus(): TunnelStatus {
    return this.requireTunnel().getStatus();
  }

  /** Escape hatch for code that reached into the ssh2 client directly. */
  public getClient(): Client {
    const tunnel = this.requireTunnel();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = (tunnel as any).client as Client | undefined;
    if (!client) {
      throw new TunnelError('TRANSPORT_NOT_READY', 'No SSH client; call connectSSH first');
    }
    return client;
  }

  /** The v2 tunnel behind this shim, for incremental migration. */
  public getTunnel(): SSHTunnel {
    return this.requireTunnel();
  }

  public async close(): Promise<void> {
    if (this.tunnel) await this.tunnel.close();
  }

  /** v1 no-ops retained so existing Electron wiring keeps compiling. */
  public onNetworkOnline(): void {}
  public onNetworkOffline(): void {}

  private requireTunnel(): SSHTunnel {
    if (!this.tunnel) {
      throw new TunnelError('TRANSPORT_NOT_READY', 'Call connectSSH before using the tunnel');
    }
    return this.tunnel;
  }
}
