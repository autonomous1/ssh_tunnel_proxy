/*
 * examples/zrok-termux.ts
 *
 * The topology this refactor was built against:
 *
 *   workstation                          phone (Termux + proot)
 *   ───────────                          ──────────────────────
 *   browser -> 127.0.0.1:8280 ─┐
 *   ssh     -> 127.0.0.1:8122 ─┤
 *                              │  SSH over a private zrok TCP share
 *                              └─ 127.0.0.1:9191 ══════════════> sshd on 127.0.0.1:8022
 *                                                                 ├─ 127.0.0.1:8080  (web app in proot)
 *                                                                 └─ 192.168.1.1:22  (LAN router)
 *
 * Bring the relay up first — this library never creates it:
 *
 *   phone:        zrok share private --backend-mode tcpTunnel 127.0.0.1:8022
 *   workstation:  zrok access private --bind 127.0.0.1:9191 <share-token>
 *   workstation:  nc 127.0.0.1 9191     # must print SSH-2.0-... before running this
 *
 * Then:  npx tsc && node build-examples/zrok-termux.js
 *
 * License: MIT
 */

import { SSHTunnel, credential, isTunnelError } from '../src/index';

async function main(): Promise<void> {
  const tunnel = new SSHTunnel(
    {
      id: 'phone',
      transport: {
        endpoint: { host: '127.0.0.1', port: 9191 },
        username: 'user',
        privateKey: credential.file('~/.ssh/id_ed25519'),
        // Documentation only. The library treats every path as a plain address.
        reachability: 'zrok',
        keepaliveIntervalMs: 10_000,
      },
      localForwards: [
        {
          id: 'app',
          listen: { host: '127.0.0.1', port: 8280 },
          target: { host: '127.0.0.1', port: 8080 },
        },
        {
          id: 'router-ssh',
          listen: { host: '127.0.0.1', port: 8122 },
          target: { host: '192.168.1.1', port: 22 },
        },
      ],
      portPolicy: {
        // 192.168.1.1:22 is privileged, so it has to be named explicitly.
        allowedPrivilegedPorts: [22],
        allowedLocalListenPorts: [8280, 8122],
        allowedRemoteHosts: ['127.0.0.1', '192.168.1.1'],
      },
      reconnect: {
        enabled: true,
        initialDelayMs: 1_000,
        maxDelayMs: 30_000,
        maxAttempts: 0, // retry forever; the phone's link comes and goes
      },
    },
    { connectionIdleTimeoutMs: 0, debugSsh: false },
  );

  tunnel.on('ready', (status) => {
    console.log(`tunnel ready via ${status.endpoint.host}:${status.endpoint.port}`);
    for (const forward of status.forwards) {
      console.log(
        `  ${forward.direction === 'local' ? 'L' : 'R'} ` +
          `${forward.listen.host}:${forward.assignedPort ?? forward.listen.port}` +
          ` -> ${forward.target.host}:${forward.target.port} [${forward.state}]`,
      );
    }
  });

  tunnel.on('forward', ({ status, previous }) => {
    if (status.state !== previous) {
      console.log(`forward ${status.forwardId}: ${previous} -> ${status.state}`);
    }
  });

  tunnel.on('reconnect', ({ attempt, delayMs, cause }) => {
    console.warn(`link lost (${cause ?? 'unknown'}); retry ${attempt} in ${delayMs}ms`);
  });

  tunnel.on('error', (err) => {
    console.error(`[${err.code}] ${err.message}`);
    if (err.code === 'TARGET_UNREACHABLE') {
      console.error('  is the service actually running on the phone side?');
    }
  });

  tunnel.on('close', () => console.log('tunnel closed'));

  try {
    await tunnel.connect();
  } catch (err) {
    if (isTunnelError(err) && err.code === 'AUTH_FAILED') {
      console.error('check that ~/.ssh/id_ed25519.pub is in the phone\'s authorized_keys');
    }
    throw err;
  }

  const app = tunnel.resolveEndpoint('app');
  console.log(`open http://${app.endpoint.host}:${app.endpoint.port}`);

  // Confirm the far side is the host we think it is.
  const { stdout } = await tunnel.exec('id -un; uname -m');
  console.log(`peer identity: ${stdout.trim().replace(/\n/g, ' ')}`);

  // A reverse forward: expose a service running here to the phone.
  const reverse = await tunnel.addRemoteForward({
    id: 'workstation-api',
    bind: { host: '127.0.0.1', port: 0 }, // let the phone pick the port
    target: { host: '127.0.0.1', port: 3000 },
  });
  console.log(`phone can reach this host's :3000 at 127.0.0.1:${reverse.assignedPort}`);

  // Periodic accounting, which v1 could not report at all.
  const reporter = setInterval(() => {
    const connections = tunnel.listConnections();
    if (connections.length === 0) return;
    console.log(`${connections.length} open connection(s):`);
    for (const connection of connections) {
      console.log(
        `  ${connection.forwardId} ${connection.state} ` +
          `↑${connection.bytesToTarget}B ↓${connection.bytesFromTarget}B`,
      );
    }
  }, 30_000);

  const shutdown = async () => {
    clearInterval(reporter);
    await tunnel.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
