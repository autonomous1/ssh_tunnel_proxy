#!/usr/bin/env node
/*
 * examples/tunnel-cli.js
 *
 * Example CLI rebuilt on the v2 API:
 *
 *     node examples/tunnel-cli.js home
 *     node examples/tunnel-cli.js all
 *
 * looks up the named entry (or every entry that is not `"disabled": true`)
 * in a config file, brings up its forwards, and holds the tunnel open until
 * Ctrl-C, reconnecting on its own if the link drops.
 *
 * Why this lives in examples/ rather than in the library
 * -----------------------------------------------------
 * v1 read ~/.config/ssh_tunnel_proxy/config.json from inside the library. That made
 * behaviour depend on the machine, made tests depend on the developer's home
 * directory, and meant a library decided where your configuration lived. v2 takes a
 * config object and nothing else. Reading a file, choosing its location, and merging
 * command-line overrides are application concerns — this file is that application,
 * in about 200 lines of dependency-free JavaScript, and you should copy and edit it.
 *
 * Config file format
 * ------------------
 * An array of entries. Both shapes are accepted:
 *
 *   v1 (what you already have on disk):
 *     { "hostname": "home", "username": "user", "host": "127.0.0.1",
 *       "port": "9191", "private_key_filename": "~/.ssh/id_ed25519",
 *       "proxy_ports": ["8280:127.0.0.1:8080"], "whitelist": { "22": true } }
 *
 *   v2 (anything TunnelConfig accepts, plus a "name" to select it by):
 *     { "name": "home", "transport": { ... }, "localForwards": [ ... ] }
 *
 * Selection order for the config file: --config, then $SSH_TUNNEL_PROXY_CONFIG,
 * then ~/.config/ssh_tunnel_proxy/config.json.
 *
 * Run `node examples/tunnel-cli.js --help` for the full option list.
 * Requires `npm run build` first, since it loads the compiled build/.
 *
 * License: MIT
 */

'use strict';

const { existsSync, readFileSync } = require('node:fs');
const { homedir } = require('node:os');
const { join, resolve } = require('node:path');
const { Worker } = require('node:worker_threads');

const {
  credential,
  legacyConfigToTunnelConfig,
  parseAndValidateLocalForward,
  parseAndValidateRemoteForward,
  whitelistToPortPolicy,
} = require('../build');

const WORKER = join(__dirname, 'tunnel-worker.js');

const DEFAULT_CONFIG_PATH = join(homedir(), '.config', 'ssh_tunnel_proxy', 'config.json');

// v1 options that v2 removed. Rejecting a whole config file over a stale key would
// be unhelpful for a CLI, so warn loudly and continue.
const REMOVED_KEYS = {
  ngrok_api: 'resolve the address yourself and put it in host/port',
  service_name: 'use private_key_filename, an env var, or ssh-agent',
  server_name: 'no longer used (it only named a keychain entry)',
  shell: 'interactive shells were removed; use ssh, or pass a command to run',
};

const USAGE = `
ssh_tunnel_proxy example CLI

Usage
  node examples/tunnel-cli.js [options] <alias|user@host> [-- command ...]

Arguments
  alias            Name of an entry in the config file ("hostname" in a v1 entry,
                   "name" or "id" in a v2 entry).
  all              Bring up every entry that is not marked "disabled": true.
  user@host        Connect ad hoc, with no config file involved.
  -- command ...   Run a command over the tunnel instead of holding it open.
                   Not valid with "all".

Options
  -F, --config <path>   Config file. Default: $SSH_TUNNEL_PROXY_CONFIG or
                        ~/.config/ssh_tunnel_proxy/config.json
  -l, --list            List the entries in the config file and exit.
  -p, --port <port>     Override the SSH port.
  -u, --user <name>     Override the SSH username.
  -i, --identity <path> Override the private key file. Use "agent" for ssh-agent.
  -L <spec>             Add a local forward, "[bind:]port:host:hostport".
                        Repeatable. Replaces the entry's forwards if given.
  -R <spec>             Add a reverse forward, "bindport:host:hostport".
                        Repeatable. Note: unlike v1, the FIRST port is the one the
                        peer binds. See MIGRATION.md.
  -s, --status <sec>    Print a connection report every N seconds. 0 = off.
      --no-reconnect    Exit on the first transport loss instead of retrying.
  -v, --verbose         Print tunnel debug output.
      --debug-ssh       Also print ssh2 protocol debug output.
  -h, --help            Show this help.

Examples
  node examples/tunnel-cli.js home
  node examples/tunnel-cli.js home -L 9090:127.0.0.1:3000 -v
  node examples/tunnel-cli.js user@127.0.0.1 -p 9191 -i ~/.ssh/id_ed25519 \\
      -L 8123:127.0.0.1:8123
  node examples/tunnel-cli.js home -- uname -a
  node examples/tunnel-cli.js all -F ./config.json
`;

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

/** Minimal argv parser: no dependencies, and `--` ends option parsing. */
function parseArgs(argv) {
  const opts = { localForwards: [], remoteForwards: [], reconnect: true, statusSeconds: 0 };
  const rest = [];
  const command = [];
  let afterDoubleDash = false;

  const next = (i, flag) => {
    const value = argv[i + 1];
    if (value === undefined) fail(`${flag} requires a value`);
    return value;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (afterDoubleDash) {
      command.push(arg);
      continue;
    }
    switch (arg) {
      case '--': afterDoubleDash = true; break;
      case '-h': case '--help': console.log(USAGE.trim()); process.exit(0); break;
      case '-l': case '--list': opts.list = true; break;
      case '-v': case '--verbose': opts.verbose = true; break;
      case '--debug-ssh': opts.debugSsh = true; break;
      case '--no-reconnect': opts.reconnect = false; break;
      case '-F': case '--config': opts.configPath = next(i, arg); i += 1; break;
      case '-p': case '--port': opts.port = next(i, arg); i += 1; break;
      case '-u': case '--user': opts.user = next(i, arg); i += 1; break;
      case '-i': case '--identity': opts.identity = next(i, arg); i += 1; break;
      case '-L': opts.localForwards.push(next(i, arg)); i += 1; break;
      case '-R': opts.remoteForwards.push(next(i, arg)); i += 1; break;
      case '-s': case '--status': opts.statusSeconds = Number(next(i, arg)); i += 1; break;
      default:
        if (arg.startsWith('-')) fail(`unknown option ${arg}`);
        rest.push(arg);
    }
  }

  opts.target = rest[0];
  opts.command = command.join(' ');
  return opts;
}

function loadConfigFile(explicitPath) {
  const path = explicitPath
    ? resolve(explicitPath)
    : process.env.SSH_TUNNEL_PROXY_CONFIG || DEFAULT_CONFIG_PATH;

  if (!existsSync(path)) return { path, entries: null };

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    fail(`cannot parse ${path}: ${err.message}`);
  }
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  return { path, entries };
}

function entryName(entry) {
  return entry.name ?? entry.id ?? entry.hostname ?? entry.host ?? '(unnamed)';
}

function warnRemovedKeys(entry) {
  for (const [key, advice] of Object.entries(REMOVED_KEYS)) {
    if (entry[key] === undefined || entry[key] === null || entry[key] === false) continue;
    console.warn(`warning: "${key}" is ignored in v2 — ${advice}`);
    delete entry[key];
  }
}

/** Turn a config-file entry, of either generation, into a v2 TunnelConfig. */
function toTunnelConfig(entry) {
  warnRemovedKeys(entry);

  // Already a v2 config: use it as-is.
  if (entry.transport) {
    const { name, ...config } = entry;
    return { id: config.id ?? name, ...config };
  }

  // v1 entry. The translator handles auth and transport; forwards are spec strings,
  // so parse them here into the config rather than adding them after connect. That
  // way a reconnect re-establishes them without the CLI doing anything.
  const config = legacyConfigToTunnelConfig(entry);
  config.id = entry.hostname ?? config.id;

  const policy = whitelistToPortPolicy(entry.whitelist);
  config.localForwards = (entry.proxy_ports ?? []).map((spec) =>
    parseAndValidateLocalForward(spec, policy),
  );
  config.remoteForwards = (entry.remote_ports ?? []).map((spec) =>
    parseAndValidateRemoteForward(spec, policy),
  );
  return config;
}

function configFromUserHost(target, opts) {
  const [username, host] = target.includes('@') ? target.split('@') : [opts.user, target];
  if (!username) fail('no username: use user@host or -u <name>');

  const identity = opts.identity ?? '~/.ssh/id_ed25519';
  return {
    id: target,
    transport: {
      endpoint: { host, port: Number(opts.port ?? 22) },
      username,
      privateKey: identity === 'agent' ? credential.agent() : credential.file(identity),
    },
  };
}

function applyOverrides(config, opts) {
  if (opts.port) config.transport.endpoint.port = Number(opts.port);
  if (opts.user) config.transport.username = opts.user;
  if (opts.identity) {
    config.transport.privateKey =
      opts.identity === 'agent' ? credential.agent() : credential.file(opts.identity);
  }
  if (opts.localForwards.length > 0) {
    config.localForwards = opts.localForwards.map((spec) =>
      parseAndValidateLocalForward(spec, config.portPolicy ?? {}),
    );
  }
  if (opts.remoteForwards.length > 0) {
    config.remoteForwards = opts.remoteForwards.map((spec) =>
      parseAndValidateRemoteForward(spec, config.portPolicy ?? {}),
    );
  }
  if (!opts.reconnect) config.reconnect = { enabled: false };
  return config;
}

function isDisabled(entry) {
  return entry.disabled === true || entry.disabled === 'true' || entry.disabled === 1;
}

function describeForward(forward) {
  const arrow = forward.direction === 'local' ? '->' : '<-';
  const port = forward.assignedPort ?? forward.listen.port;
  return (
    `  ${forward.direction === 'local' ? 'L' : 'R'} ${forward.listen.host}:${port} ` +
    `${arrow} ${forward.target.host}:${forward.target.port}  [${forward.state}]`
  );
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { path, entries } = loadConfigFile(opts.configPath);

  if (opts.list) {
    if (!entries) fail(`no config file at ${path}`);
    console.log(`${path}:`);
    for (const entry of entries) {
      const generation = entry.transport ? 'v2' : 'v1';
      const where = entry.transport
        ? `${entry.transport.endpoint.host}:${entry.transport.endpoint.port}`
        : `${entry.host ?? entry.hostname}:${entry.port ?? 22}`;
      const forwards = (entry.proxy_ports ?? entry.localForwards ?? []).length;
      const flag = entry.disabled ? ' (disabled)' : '';
      console.log(`  ${entryName(entry).padEnd(16)} ${generation}  ${where}  ${forwards} forward(s)${flag}`);
    }
    return;
  }

  if (!opts.target) {
    console.error(USAGE.trim());
    process.exit(2);
  }

  const sessions = [];

  function startSession(config, label) {
    return new Promise((resolve) => {
      const worker = new Worker(WORKER, {
        workerData: {
          config,
          label,
          verbose: Boolean(opts.verbose),
          debugSsh: Boolean(opts.debugSsh),
        },
      });
      const session = { worker, label, state: 'connecting', ready: false };
      sessions.push(session);

      const finish = (ok) => {
        if (session.settled) return;
        session.settled = true;
        resolve(ok ? session : null);
      };

      worker.on('message', (msg) => {
        if (msg.type === 'log') console.error(msg.line);
        if (msg.type === 'ready') {
          session.ready = true;
          session.state = 'ready';
          console.error(`connected to ${msg.username}@${msg.host}:${msg.port} [${label}]`);
          finish(true);
        }
        if (msg.type === 'failed') {
          session.state = 'failed';
          console.error(`error [${label} ${msg.code}] ${msg.message}`);
          if (msg.code === 'AUTH_FAILED') {
            console.error("  check that your public key is in the peer's authorized_keys");
          }
          if (msg.code === 'CHANNEL_OPEN_FAILED' || msg.code === 'TRANSPORT_NOT_READY') {
            const ep = config.transport.endpoint;
            console.error(`  is a raw SSH listener really at ${ep.host}:${ep.port}?`);
            console.error(`  check with: nc ${ep.host} ${ep.port}`);
          }
          finish(false);
        }
        if (msg.type === 'state') session.state = msg.current;
        if (msg.type === 'status') {
          console.error(`-- [${label}] ${msg.state}, ${msg.connections.length} open connection(s)`);
          for (const connection of msg.connections) {
            console.error(
              `   ${connection.forwardId} ${connection.state} ` +
                `up ${connection.bytesToTarget}B down ${connection.bytesFromTarget}B`,
            );
          }
        }
        if (msg.type === 'exec-result' && session.execWait) {
          session.execWait(msg);
          session.execWait = undefined;
        }
      });

      worker.on('error', (err) => {
        console.error(`worker [${label}] ${err.message}`);
        session.state = 'failed';
        finish(false);
      });

      worker.on('exit', () => {
        if (session.state !== 'failed') session.state = 'closed';
        finish(false);
        const live = sessions.filter((item) => item.state !== 'failed' && item.state !== 'closed');
        if (session.settled && live.length === 0 && !session.holdingExit) {
          if (sessions.some((item) => item.ready)) {
            console.error('all tunnels closed; exiting');
            process.exit(session.state === 'failed' ? 1 : 0);
          }
        }
      });
    });
  }

  function execOn(session, command) {
    return new Promise((resolve) => {
      session.execWait = resolve;
      session.worker.postMessage({ op: 'exec', command });
    });
  }

  if (opts.target === 'all') {
    if (!entries) fail(`alias "all" given but no config file at ${path}`);
    if (opts.command) fail('"all" cannot run a remote command; pick a single alias');
    if (opts.localForwards.length > 0 || opts.remoteForwards.length > 0) {
      fail('"all" cannot take -L / -R; those would collide across hosts. Set forwards on each entry');
    }
    const selected = entries.filter((entry) => !isDisabled(entry));
    if (selected.length === 0) fail(`no enabled entries in ${path}`);
    console.error(`starting ${selected.length} tunnel(s) from ${path}`);
    const results = await Promise.all(
      selected.map((entry) => {
        const name = entryName(entry);
        const config = applyOverrides(toTunnelConfig(entry), opts);
        return startSession(config, name).then((session) => ({ name, session }));
      }),
    );
    const down = results.filter((row) => !row.session);
    for (const row of down) console.error(`skipped ${row.name}: connect failed`);
    if (!results.some((row) => row.session)) process.exit(1);
  } else {
    let config;
    let label;
    if (opts.target.includes('@')) {
      config = configFromUserHost(opts.target, opts);
      label = opts.target;
    } else {
      if (!entries) fail(`alias "${opts.target}" given but no config file at ${path}`);
      const entry = entries.find((candidate) => entryName(candidate) === opts.target);
      if (!entry) {
        fail(
          `no entry named "${opts.target}" in ${path}. ` +
            `Available: ${entries.map(entryName).join(', ') || '(none)'}`,
        );
      }
      if (isDisabled(entry)) fail(`entry "${opts.target}" is disabled`);
      config = toTunnelConfig(entry);
      label = opts.target;
    }

    applyOverrides(config, opts);
    const session = await startSession(config, label);
    if (!session) process.exit(1);

    if (opts.command) {
      session.holdingExit = true;
      const result = await execOn(session, opts.command);
      process.stdout.write(result.stdout ?? '');
      process.stderr.write(result.stderr ?? '');
      session.worker.postMessage({ op: 'close' });
      process.exit(result.code ?? 0);
    }
  }

  const readyCount = sessions.filter((item) => item.ready).length;
  console.error(`tunnel is up (${readyCount} ready). Ctrl-C to close.`);

  let reporter;
  if (opts.statusSeconds > 0) {
    reporter = setInterval(() => {
      for (const session of sessions) {
        if (session.state === 'closed' || session.state === 'failed') continue;
        session.worker.postMessage({ op: 'status' });
      }
    }, opts.statusSeconds * 1000);
    reporter.unref?.();
  }

  const shutdown = async (signal) => {
    console.error(`\n${signal}: closing`);
    if (reporter) clearInterval(reporter);
    await Promise.all(
      sessions.map((session) => {
        session.holdingExit = true;
        return session.worker.terminate().catch(() => {});
      }),
    );
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGHUP', () => void shutdown('SIGHUP'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
