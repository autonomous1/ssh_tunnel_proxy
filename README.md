# ssh_tunnel_proxy

SSH port forwarding for Node.js. You give it an SSH listener that already exists
at `host:port`. It keeps local (`ssh -L`) and reverse (`ssh -R`) forwards up over
that connection.

```text
  browser ──▶ 127.0.0.1:8280 ──▶ [ SSH ] ──▶ 127.0.0.1:8123 on the far side
```

The only runtime dependency is [`ssh2`](https://github.com/mscdex/ssh2).

## Why not `ssh -L`?

OpenSSH already does the same forwarding. Use it when a single hop stays up and
you are fine supervising the process yourself.

This package is for the hop that does not stay up — a phone, a NAT mapping, a
zrok or ngrok TCP share — and for code that has to *do something* when it drops.

| `ssh -L` / `ssh -R` | `ssh_tunnel_proxy` |
| --- | --- |
| A process you start and hope stays running | An object with `connect()`, `close()`, and events |
| Local port vanishes on drop (`ECONNREFUSED`, then a race to bind it again) | Listener stays bound in `degraded`; new clients fail fast; same port comes back |
| `ServerAliveInterval` or a restart loop in a shell | Bounded reconnect with backoff, or a hard stop at `maxAttempts` |
| stderr and exit codes | `TunnelError` with a stable `code` (`AUTH_FAILED`, `TARGET_UNREACHABLE`, …) |
| One shared stream per reverse forward in naive wrappers | One SSH channel and one TCP socket per connection |
| No picture of what is open | `getStatus()`, `listConnections()`, byte counts |

It does not replace `sshd`, generate keys, or create the relay. It is the layer
on top of an SSH listener that keeps forwards honest when the path is flaky.

## Install

```bash
npm install ssh_tunnel_proxy
```

The package includes `examples/tunnel-cli.js`. After `npm run build` (or from a
clone), you can bring forwards up with no application code.

## Quick start: the CLI

Copy `examples/config.example.json`, point each `transport.endpoint` at a host
that already speaks SSH, and give every service its own loopback listen port.

```json
[
  {
    "name": "pi-living",
    "transport": {
      "endpoint": { "host": "192.168.1.21", "port": 22 },
      "username": "user",
      "privateKey": { "source": "file", "value": "~/.ssh/id_ed25519" }
    },
    "localForwards": [
      { "id": "ha", "listen": { "host": "127.0.0.1", "port": 8123 }, "target": { "host": "127.0.0.1", "port": 8123 } }
    ]
  },
  {
    "name": "pi-garage",
    "transport": {
      "endpoint": { "host": "192.168.1.22", "port": 22 },
      "username": "user",
      "privateKey": { "source": "file", "value": "~/.ssh/id_ed25519" }
    },
    "localForwards": [
      { "id": "cameras", "listen": { "host": "127.0.0.1", "port": 8080 }, "target": { "host": "127.0.0.1", "port": 8080 } }
    ],
    "disabled": false
  }
]
```

The example CLI starts one `worker_threads` Worker per config entry, so
each session has its own event loop. A blocked tick or a drop on one
board does not stall the others, and a local port stays bound while that
hop reconnects.

```bash
node examples/tunnel-cli.js --list -F ./config.json
node examples/tunnel-cli.js all    -F ./config.json
```

`all` starts every entry that is not `"disabled": true`. Open
`http://127.0.0.1:8123` and `http://127.0.0.1:8080` in a browser on this
machine. Ctrl-C closes the lot.

A single host, or an override without editing the file:

```bash
node examples/tunnel-cli.js pi-living -F ./config.json
node examples/tunnel-cli.js pi-living -F ./config.json -L 9090:127.0.0.1:3000
node examples/tunnel-cli.js user@192.168.1.21 -i ~/.ssh/id_ed25519 \
    -L 8123:127.0.0.1:8123
```

Config path: `-F` / `--config`, else `$SSH_TUNNEL_PROXY_CONFIG`, else
`~/.config/ssh_tunnel_proxy/config.json`. v1 and v2 entry shapes are both
accepted. The CLI is an example on purpose — the library itself still takes a
`TunnelConfig` object and does not read a file.

Two config entries are two SSH sessions — and two Workers — even if they
point at the same host. That is how you isolate a filesystem mount from
a database on one VPS. Give each entry its own listen ports.

```json
[
  {
    "name": "vps-fs",
    "transport": {
      "endpoint": { "host": "host.example.net", "port": 22 },
      "username": "user",
      "privateKey": { "source": "file", "value": "~/.ssh/id_ed25519" }
    },
    "localForwards": [
      { "id": "sshd", "listen": { "host": "127.0.0.1", "port": 2222 }, "target": { "host": "127.0.0.1", "port": 22 } }
    ],
    "portPolicy": { "allowedPrivilegedPorts": [22], "allowedRemoteHosts": ["127.0.0.1"] }
  },
  {
    "name": "vps-mariadb",
    "transport": {
      "endpoint": { "host": "host.example.net", "port": 22 },
      "username": "user",
      "privateKey": { "source": "file", "value": "~/.ssh/id_ed25519" }
    },
    "localForwards": [
      { "id": "mariadb", "listen": { "host": "127.0.0.1", "port": 13306 }, "target": { "host": "127.0.0.1", "port": 3306 } }
    ]
  }
]
```

```bash
node examples/tunnel-cli.js all -F ./config.json
sshfs -p 2222 user@127.0.0.1:/var/www ~/mnt/vps -o reconnect
# MariaDB clients: 127.0.0.1:13306
```

A flap on the SFTP hop does not take the database session with it.

### Do not block the event loop

`ssh2` and this library run on Node’s single JS thread. A synchronous
`JSON.parse` of a large file, a tight CPU loop, or a giant
`readFileSync` in the **same process** pauses *every* tunnel in that
process: accepts, channel data, keepalives, and reconnect timers.

The example CLI is safe because it only reads a small config and then
moves bytes. If you embed `SSHTunnel` in an app that also parses,
indexes, or transforms large payloads:

- Prefer `worker_threads` (or a child process) for that work.
- Keep the process that calls `connect()` dedicated to SSH and local
  sockets.
- Do not `JSON.parse` multi‑megabyte buffers on the tunnel tick.

The example CLI already puts each session on its own Worker. If you
embed `SSHTunnel` in a larger app, do the same — or use `worker_threads`
for parse/CPU and keep one dedicated Worker (or process) per transport.

## Quick start: the library

Same forwards from your own process, for example Home Assistant at
`127.0.0.1:8123`:

```ts
import { SSHTunnel, credential } from 'ssh_tunnel_proxy';

const tunnel = new SSHTunnel({
  transport: {
    endpoint: { host: '127.0.0.1', port: 9191 },
    username: 'user',
    privateKey: credential.file('~/.ssh/id_ed25519'),
  },
  localForwards: [
    {
      id: 'home-assistant',
      listen: { host: '127.0.0.1', port: 8123 },
      target: { host: '127.0.0.1', port: 8123 },
    },
  ],
});

tunnel.on('error', (err) => console.error(err.code, err.message));
await tunnel.connect();

const { endpoint } = tunnel.resolveEndpoint('home-assistant');
console.log(`open http://${endpoint.host}:${endpoint.port}`);

await tunnel.close();
```

`9191` is whatever local port your relay (zrok, ngrok, Tailscale, or a LAN
address) already bound. This package does not create that listener.

### Reverse forward

Expose a process on this machine to the peer (`ssh -R`):

```ts
const status = await tunnel.addRemoteForward({
  id: 'dev-server',
  bind: { host: '127.0.0.1', port: 0 }, // 0 = peer chooses the port
  target: { host: '127.0.0.1', port: 3000 },
});

console.log('peer is listening on', status.assignedPort);
```

Each inbound connection gets its own SSH channel and its own TCP socket.

### Several services on one transport

```ts
localForwards: [
  { id: 'home-assistant', listen: { host: '127.0.0.1', port: 8123 }, target: { host: '127.0.0.1', port: 8123 } },
  { id: 'cameras',        listen: { host: '127.0.0.1', port: 8080 }, target: { host: '127.0.0.1', port: 8080 } },
]
```

Open `http://127.0.0.1:8123` and `http://127.0.0.1:8080` in a browser on this
machine. Listeners bind loopback only.

## What this package does not do

See [MIGRATION.md](./MIGRATION.md) for the v1 mapping.

| Out of scope | Do this instead |
| --- | --- |
| Key generation and keychains | `credential.file`, `credential.env`, `credential.agent`, or `credential.callback` |
| Creating a zrok / ngrok / Tailscale share | Start the relay yourself, then pass `host:port` |
| Interactive shells | Use `ssh`, or `tunnel.exec()` for one command |
| Reading `~/.config/ssh_tunnel_proxy/config.json` | Pass a `TunnelConfig` object |

## Using a TCP relay (zrok, ngrok, …)

1. On the host that runs `sshd` and the private apps, share the SSH port. With zrok:

   ```bash
   zrok share private --backend-mode tcpTunnel 127.0.0.1:22
   ```

2. On the machine that will run this library, bind that share locally and check
   that it really is SSH:

   ```bash
   zrok access private --bind 127.0.0.1:9191 <share-token>
   nc 127.0.0.1 9191    # must print SSH-2.0-...
   ```

3. Point `transport.endpoint` at `127.0.0.1:9191`.

A longer copy of this pattern is in `examples/zrok-termux.ts`.

## API

### `new SSHTunnel(config, options?)`

`TunnelConfig` matches `proto/sshtunnel/v1/tunnel.proto`.

| Method | Returns | Notes |
| --- | --- | --- |
| `connect()` | `Promise<TunnelStatus>` | Idempotent; concurrent calls share one attempt. |
| `close()` | `Promise<TunnelStatus>` | Idempotent. Stops reconnect and closes everything. |
| `addLocalForward(spec \| string)` | `Promise<ForwardStatus>` | Object or `"8280:127.0.0.1:8080"`. |
| `addLocalForwards(specs[])` | `Promise<ForwardStatus[]>` | Atomic: one bind failure rolls all of them back. |
| `addRemoteForward(spec \| string)` | `Promise<ForwardStatus>` | `bind.port: 0` → read `assignedPort`. |
| `addRemoteForwards(specs[])` | `Promise<ForwardStatus[]>` | Atomic, as above. |
| `removeForward(id)` | `Promise<ForwardStatus>` | Unbinds the listener and closes its connections. |
| `resolveEndpoint(id)` | `{ endpoint, state }` | Where to connect, including a peer-assigned port. |
| `getStatus()` | `TunnelStatus` | Tunnel + every forward. |
| `getForwardStatus(id)` | `ForwardStatus` | One forward. |
| `listConnections()` | `ConnectionStatus[]` | Live proxied connections and byte counts. |
| `getState()` / `isReady()` | `TunnelState` / `boolean` | |
| `exec(command, streams?)` | `Promise<{ code, stdout, stderr }>` | One command. No TTY. |

### Events

| Event | Payload | When |
| --- | --- | --- |
| `state` | `{ previous, current, reason? }` | Tunnel state change. |
| `ready` | `TunnelStatus` | Transport up and forwards open. Also after a successful reconnect. |
| `forward` | `{ status, previous }` | A forward changes state. |
| `connection` | `{ status, previous }` | One proxied connection changes state. |
| `reconnect` | `{ attempt, delayMs, cause? }` | A retry is scheduled. |
| `error` | `TunnelError` | Always has a `code`. |
| `close` | `TunnelStatus` | Reached `closed`. |
| `debug` | `(message, ...args)` | Tracing. `options.debugSsh` enables ssh2 protocol logs. |

### States

```text
tunnel      idle → connecting → ready ⇄ reconnecting → closing → closed
                              ↘ failed

forward     pending → opening → active ⇄ degraded → closing → closed
                              ↘ failed

connection  accepted → opening → piped → half_closed → closed
                              ↘ failed
```

`degraded`: the local listener stays bound while SSH is down. New clients fail
fast instead of getting `ECONNREFUSED` and racing to rebind. When SSH returns the
same forward becomes `active` again.

### Errors

Branch on `err.code`, not on the message:

```ts
import { isTunnelError } from 'ssh_tunnel_proxy';

try {
  await tunnel.addLocalForward('80:127.0.0.1:8080');
} catch (err) {
  if (isTunnelError(err) && err.code === 'PORT_NOT_PERMITTED') {
    // privileged listen port was not allowlisted
  }
}
```

`INVALID_FORWARD_SPEC`, `PORT_NOT_PERMITTED`, `HOST_NOT_PERMITTED`,
`TRANSPORT_NOT_READY`, `AUTH_FAILED`, `LISTEN_FAILED`, `REMOTE_BIND_FAILED`,
`CHANNEL_OPEN_FAILED`, `TARGET_UNREACHABLE`, `DUPLICATE_FORWARD_ID`,
`UNKNOWN_FORWARD`, `CONNECTION_LIMIT`, `RECONNECT_EXHAUSTED`,
`CREDENTIAL_UNRESOLVED`.

## Credentials

The library only resolves a reference. It never writes a secret.

```ts
credential.file('~/.ssh/id_ed25519')
credential.env('SSH_PRIVATE_KEY')
credential.inline(pem)
credential.agent()
credential.callback('vault://key')   // needs options.credentialResolver
```

Optional host-key check:

```ts
transport: {
  // ...
  hostKeyFingerprints: ['sha256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU'],
}
```

Omit fingerprints only on a path that is already authenticated (a private share).

## Port policy

Local listen ports and remote target ports are separate decisions. Local listeners
must be loopback (`127.0.0.1` or `::1`).

```ts
portPolicy: {
  allowedPrivilegedPorts: [22, 80, 443],
  allowedLocalListenPorts: [8123, 8080],
  allowedRemoteTargetPorts: [8123, 8080, 22],
  allowedRemoteHosts: ['127.0.0.1', '192.168.1.1'],
}
```

Order: valid TCP port (remote bind may be `0`); ports below 1024 need
`allowedPrivilegedPorts`; a non-empty role list must include the port. No policy
means any unprivileged port, no privileged port.

## Data model

`proto/sshtunnel/v1/tunnel.proto` is the cross-language source of truth.
`src/model.ts` is a hand-written TypeScript projection; a unit test fails if they
drift. The runtime does not depend on protobuf.

## Migrating from v1

`SSHTunnelProxy` still exists:

```ts
import { SSHTunnelProxy } from 'ssh_tunnel_proxy';

const proxy = new SSHTunnelProxy();
proxy.on('ssh_tunnel_ready', () => console.log('up'));
await proxy.connectSSH(
  {
    username: 'user',
    host: '127.0.0.1',
    port: '9191',
    private_key_filename: '~/.ssh/id_ed25519',
    proxy_ports: ['8123:127.0.0.1:8123'],
  },
  { 22: true, 80: true, 443: true },
);
```

`ngrok_api`, `service_name`, and `shell` throw. Details in
[MIGRATION.md](./MIGRATION.md).

## Development

```bash
npm install
npm run build
npm test
```

Integration tests run an in-process `ssh2.Server`. No external `sshd` or network
is required.

## License

MIT. See [LICENSE](./LICENSE).
