# ssh_tunnel_proxy — analysis and failure-mode harness

## What the library is

v2 is a narrow SSH forwarding library. It does **not** create relays, keys, or
shells. Given an SSH listener that already exists at `host:port`, it maintains
local (`-L`) and remote (`-R`) TCP forwards, reconnects with backoff, and
exposes typed state for the tunnel, each forward, and each proxied connection.

Runtime dependency: `ssh2` only. Integration tests already stand up an
in-process `ssh2.Server` (see `test/helpers/ssh-testbench.js`).

## State machines

```
tunnel      idle → connecting → ready ⇄ reconnecting → closing → closed
                              ↘ failed

forward     pending → opening → active ⇄ degraded → closing → closed
                              ↘ failed

connection  accepted → opening → piped → half_closed → closed
                              ↘ failed
```

`degraded` is the operational core: a local listener stays bound across a
transport drop so callers see a fast failure instead of `ECONNREFUSED` plus a
race to rebind the port.

## Error catalog (closed set)

| Code | Typical force |
| --- | --- |
| `INVALID_FORWARD_SPEC` | Malformed `-L` / `-R` string |
| `PORT_NOT_PERMITTED` | Port < 1024 without `allowedPrivilegedPorts` |
| `HOST_NOT_PERMITTED` | Target host not in `allowedRemoteHosts` |
| `TRANSPORT_NOT_READY` | `addRemoteForward` before `connect()` |
| `AUTH_FAILED` | Wrong private key |
| `CREDENTIAL_UNRESOLVED` | No key / password / agent |
| `LISTEN_FAILED` | Local port already bound |
| `REMOTE_BIND_FAILED` | Peer rejects `tcpip-forward` |
| `CHANNEL_OPEN_FAILED` | Peer rejects `direct-tcpip` |
| `TARGET_UNREACHABLE` | Destination TCP port closed |
| `DUPLICATE_FORWARD_ID` | Same id added twice |
| `UNKNOWN_FORWARD` | `resolveEndpoint` / `removeForward` missing id |
| `CONNECTION_LIMIT` | `maxConnections` exceeded |
| `RECONNECT_EXHAUSTED` | Finite retries against a dead listener |

## Existing coverage vs. this harness

Already covered well:

- Happy-path local and remote forwards, concurrent connections (v1 bug)
- Transport drop → degrade → reconnect → restore
- Auth failure, missing credentials, host-key mismatch
- Reconnect disabled → `failed`; maxAttempts → `RECONNECT_EXHAUSTED`
- CLI example as a child process
- Unit tests for spec parsing, port policy, credentials, model/proto parity

Gaps this harness closes:

- Every published `TunnelError` code has a forcing test
- Peer-side `tcpip-forward` rejection (`REMOTE_BIND_FAILED`)
- Peer-side `direct-tcpip` rejection
- Listen collision and atomic `addLocalForwards` rollback
- Connection cap
- In-flight stream killed by RST of the SSH client
- Black-hole and reset targets (phone service gone, not the SSH hop)
- Close-while-reconnecting must not leave a live timer

## How to run

From this directory (after `npm install`):

```bash
npm run build
npx mocha --timeout 20000 test/integration/failure-modes.test.js
# or the full suite
npm test
```

Fault knobs live in `test/helpers/fault-injector.js`:

- `rejectAuth`, `rejectDirectTcpip`, `rejectTcpipForward`
- `delayDirectTcpipMs`, `dropAfterBytes`, `acceptThenReset`
- `dropConnections()` / `resetConnections()`
- `ResetTarget`, `BlackHoleTarget`

## Suggested next faults (not in this pass)

- Keepalive timeout without a TCP drop (idle NAT mapping)
- Peer-assigned remote port changing across reconnects
- `credential.callback` resolver throwing mid-reconnect
- Half-close: client FIN, target still writing
- `connectionIdleTimeoutMs` firing under load
- Host-key rotation on the in-process server
