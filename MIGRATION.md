# Migrating from ssh_tunnel_proxy v1 to v2

v2 keeps the package name and keeps `ssh2` as the transport. What changed is scope:
the library now assumes **an SSH listener already exists at a host and port you
supply**, and concerns itself only with forwards over that transport.

Three things were removed outright, three things were added.

Removed: key generation and keychain storage, ngrok endpoint discovery, interactive
shells (plus the implicit read of `~/.config/ssh_tunnel_proxy/config.json`).

Added: a language-neutral `.proto` data model, a first-class `SSHTunnel` API with
typed events and per-connection state, and correct handling of many simultaneous
connections per forward.

## The fastest path: keep using the shim

`SSHTunnelProxy` still exists. If you delete the removed options, most v1 programs
run unchanged:

```diff
 const proxy = new SSHTunnelProxy();
 await proxy.connectSSH({
   username: 'u0_a272',
   host: '127.0.0.1',
   port: '9191',
   private_key_filename: '~/.ssh/id_ed25519',
   proxy_ports: ['8280:127.0.0.1:8080'],
-  ngrok_api: process.env.NGROK_API_KEY,
-  service_name: 'sshtun',
-  shell: false,
 }, { 22: true, 80: true, 443: true });
```

Leaving `ngrok_api`, `service_name` or `shell` in place throws immediately with a
message pointing here, rather than quietly doing something different from v1.

`proxy.getTunnel()` returns the v2 `SSHTunnel` behind the shim, so you can migrate
call sites one at a time.

## Option mapping

| v1 option | v2 | Notes |
| --- | --- | --- |
| `username` | `transport.username` | |
| `host` / `hostname` | `transport.endpoint.host` | `host` wins; `hostname` is still accepted |
| `port` | `transport.endpoint.port` | Now a real number, validated. v1 used `parseInt`, so `"22abc"` became `22`; that now throws |
| `private_key_filename` | `transport.privateKey = credential.file(path)` | `~` still expands |
| `private_key` | `transport.privateKey = credential.inline(pem)` | |
| `password` | `transport.password = credential.inline(...)` | An empty string is now dropped rather than attempted |
| `proxy_ports` | `localForwards` | The v1 string form still works everywhere a `LocalForward` is accepted |
| `remote_ports` | `remoteForwards` | **Field order changed — see below** |
| `whitelist` | `portPolicy` | `whitelistToPortPolicy()` converts a v1 whitelist object |
| `keepaliveInterval` | `transport.keepaliveIntervalMs` | Same default of 10000 |
| `exec` | `exec` on the shim, or `tunnel.exec(cmd)` | Still runs after connect on the shim |
| `server_name` | *gone* | It only existed to name a keychain entry |
| `service_name` | *gone* | Keychain storage removed |
| `ngrok_api` | *gone* | Resolve the address yourself and pass `host:port` |
| `shell` | *gone* | Not port forwarding |
| `disabled` | *gone* | Do not construct the tunnel |

## Breaking change to watch: reverse-forward spec strings

This is the one silent behaviour change, so check it if you used `remote_ports`.

```text
v1  "9090:127.0.0.1:3000"  →  localPort : targetHost : remotePort
v2  "9090:127.0.0.1:3000"  →  bindPort  : targetHost : targetPort
```

v2 reads a three-field reverse spec the way `ssh -R` does: the **first** field is the
port the peer binds, and the last field is the port on **this** side that traffic is
delivered to. If your v1 values had the two ports the same — which is by far the
most common case — nothing changes. If they differed, swap them.

The unambiguous form is the object:

```ts
await tunnel.addRemoteForward({
  bind: { host: '127.0.0.1', port: 9090 },   // on the peer
  target: { host: '127.0.0.1', port: 3000 }, // reachable from here
});
```

Use `bind.port: 0` to let the peer assign a port, then read `assignedPort` from the
returned status. v1 had no way to express that.

## The `ssh2-node <alias>` command line

v1 shipped a `commander`-based CLI that read
`~/.config/ssh_tunnel_proxy/config.json`, matched an alias against each entry's
`hostname`, and connected — usually dropping you into a remote shell.

The v2 equivalent is `examples/tunnel-cli.js`, which is dependency-free plain
JavaScript you are meant to copy and edit:

```bash
node examples/tunnel-cli.js rh2          # same alias, same config file
node examples/tunnel-cli.js --list       # new: see what is in the file
node examples/tunnel-cli.js rh2 -- uname -a
```

It reads the same file from the same default path, and accepts v1-shaped entries
directly. Differences:

| v1 CLI | v2 example CLI |
| --- | --- |
| `ssh2-node rh2` | `node examples/tunnel-cli.js rh2` |
| `-L` / `-R` | `-L` / `-R`, same repeatable form (mind the `-R` field order above) |
| `-i`, `-p`, `-v` | Same, plus `-u` and `--debug-ssh` |
| No argument after the host → remote shell | Holds the tunnel open instead; use `ssh` through the forward |
| Trailing command → exec then exit | `-- command ...` → exec then exit with its status |
| `-J` / `-j` keychain lookup | Gone. Use `-i <path>` or `-i agent` |
| `-H` ngrok lookup | Gone. Put the resolved address in the entry |
| Iterated *all* matching config entries | Selects exactly one entry, and says so if the alias is missing |
| ~35 mostly unimplemented `ssh(1)` flags | Only the flags that do something |
| Config read inside the library | Config read by the CLI and passed in as an object |

That last row is the point: the library no longer reads any file, so the same code
behaves identically on your workstation, in a container, and in the test suite.
Stale keys such as `service_name` or `ngrok_api` in an existing config file produce a
warning from the CLI and are skipped, so your file keeps working while you clean it
up.

## Method mapping

| v1 | v2 |
| --- | --- |
| `new SSHTunnelProxy()` + `connectSSH(opts, whitelist)` | `new SSHTunnel(config)` + `connect()` |
| `setupProxyPorts(ports)` | `addLocalForwards(specs)` — now atomic, and returns statuses |
| `setupRemotePorts(ports)` | `addRemoteForwards(specs)` |
| *(no equivalent)* | `removeForward(id)` |
| *(no equivalent)* | `resolveEndpoint(id)`, `getForwardStatus(id)`, `listConnections()` |
| `execCmd(cmd, out, err)` | `exec(cmd, { stdout, stderr })` — resolves with `{ code, stdout, stderr }` |
| `getClient()` | `getClient()` on the shim; v2 code should not need the raw client |
| `generateAndStoreKeypair()` | *gone* — use `ssh-keygen` |
| `getPublicKey()` | *gone* |
| `onNetworkOnline()` / `onNetworkOffline()` | *gone*; no-ops on the shim. Reconnection is now automatic and driven by the transport itself |
| `validate_port_number(port, whitelist)` | `checkPort(port, role, policy)` — the shim keeps the old boolean form |
| `validate_local_forward(ports, whitelist)` | `parseAndValidateLocalForward(spec, policy)` |
| `do_ssh_connect(...)` | *gone* (was internal) |

## Events

| v1 event | v2 |
| --- | --- |
| `ssh_tunnel_ready` | `ready`, carrying a full `TunnelStatus`. The shim still emits `ssh_tunnel_ready`, now exactly once per successful connect |
| `status` | `state` (tunnel), `forward` (per forward), `connection` (per connection). The shim still emits `status` |
| `debug` | `debug` |
| `error` | `error`, always a `TunnelError` with a `code` |
| *(none)* | `reconnect`, `close` |

`error` is worth re-reading: in v1, some failures were logged and others were thrown
from deep inside a callback. In v2 anything non-fatal is emitted as a coded
`TunnelError`, and only the operation you called rejects.

## Behaviour differences you may actually notice

1. **Concurrent reverse-forward connections work.** v1 reused a single outbound
   socket for every channel of a reverse forward, so a second simultaneous
   connection interleaved with the first. v2 opens one socket per channel. There is a
   test that fails if this regresses.

2. **Port validation is stricter.** `parseInt`-style values such as `"80abc"` and
   `"22.5"` are rejected instead of truncated.

3. **Port policy is explicit and role-aware.** v1 applied one whitelist to
   everything. v2 asks separately about local listen ports, remote target ports,
   remote bind ports and remote hosts. With no policy supplied, any unprivileged port
   is permitted and no privileged port is.

4. **A dropped transport degrades rather than disappears.** Local listeners stay
   bound while reconnection is in progress, so callers get a fast failure instead of
   connection-refused, and the port cannot be stolen by another process in the gap.
   Forwards return to `active` automatically.

5. **Adding several forwards is atomic.** If the third of three fails to bind, the
   first two are rolled back, so you never end up half-configured.

6. **Nothing is read from disk implicitly.** v1 read
   `~/.config/ssh_tunnel_proxy/config.json`; v2 only uses the config object you pass.
   This is also why the test suite no longer depends on the machine it runs on.

7. **Host keys can be verified.** Set `transport.hostKeyFingerprints` to one or more
   `sha256:...` values. Omitting it accepts any host key, as v1 always did.

## Where key management went

Out of the package. Choose whichever fits your deployment:

```ts
credential.file('~/.ssh/id_ed25519')  // ssh-keygen, file permissions, done
credential.env('SSH_PRIVATE_KEY')     // containers and CI
credential.agent()                    // ssh-agent, no key bytes in your process
credential.callback('vault://ssh/id') // your own resolver, e.g. Vault or an OS keychain
```

`credential.callback` plus `options.credentialResolver` is the seam where the old
`keytar` behaviour belongs if you still want it — as ten lines in your application,
not as a native dependency of a forwarding library.

## Where ngrok went

Also out of the package. v1 called the ngrok API to discover where the SSH daemon
was, which coupled the transport to one vendor. v2 takes an address:

```ts
// zrok: `zrok access private --bind 127.0.0.1:9191 <token>` on this machine
endpoint: { host: '127.0.0.1', port: 9191 }

// ngrok: read the address from the ngrok API in your own code, then
endpoint: { host: '4.tcp.ngrok.io', port: 12345 }

// Tailscale, WireGuard, LAN, jump host — all just an address
endpoint: { host: '100.64.0.7', port: 22 }
```

`transport.reachability` (`'direct' | 'zrok' | 'ngrok' | 'custom'`) exists only to
label how you got there. It changes no behaviour.

## Cross-language use

`proto/sshtunnel/v1/tunnel.proto` defines the config, status and event model plus an
optional `TunnelControl` gRPC service, so another runtime can drive or observe the
same model. The Node runtime has no protobuf dependency and no codegen step; the
proto file is the specification, and `test/unit/model-parity.test.js` fails the build
if `src/model.ts` drifts from it.
