/*
 * Replication of the external failure-mode matrix.
 *
 * Names and assertions follow that suite so the two known failures
 * (target crash leaving a client socket open; hammer-during-flap not
 * settling) can be reproduced here without the original files.
 */

const assert = require('node:assert/strict');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { mkdtempSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { describe, it, before, after, afterEach } = require('mocha');

const { SSHTunnel, credential, validateLocalForward } = require('../../build');
const { EchoServer, roundTrip, openConnection, freePort } = require('../helpers/ssh-testbench');
const {
  FaultySSHTestBench,
  RestartableService,
  BlackHoleTarget,
  waitFor: waitEvent,
  expectCode,
  connectDeadline,
  firstNonLoopbackIPv4,
} = require('../helpers/fault-injector');
const { waitForSocketDeath, hold } = require('../helpers/tcp_client');
const { waitFor } = require('../helpers/wait_for');

const CLI = join(__dirname, '..', '..', 'examples', 'tunnel-cli.js');

function countReconnects(tunnel) {
  let n = 0;
  tunnel.on('reconnect', () => {
    n += 1;
  });
  return () => n;
}

describe('failure: SSH transport drops or restarts', function () {
  let bench;
  let echo;
  let tunnel;

  before(async function () {
    bench = new FaultySSHTestBench();
    await bench.start();
    echo = new EchoServer('drop:');
    await echo.start();
  });

  after(async function () {
    if (tunnel) await tunnel.close();
    await echo.stop();
    await bench.stop();
  });

  afterEach(async function () {
    if (tunnel) {
      await tunnel.close();
      tunnel = undefined;
    }
  });

  function makeTunnel(overrides) {
    return new SSHTunnel({
      transport: {
        endpoint: { host: '127.0.0.1', port: bench.port },
        username: 'tester',
        privateKey: credential.inline(bench.clientKey.private),
      },
      ...overrides,
    });
  }

  it('does not survive a drop on an already-open data channel (and must not pretend to)', async function () {
    const listenPort = await freePort();
    tunnel = makeTunnel({
      reconnect: { enabled: false },
      localForwards: [
        {
          id: 'live',
          listen: { host: '127.0.0.1', port: listenPort },
          target: { host: '127.0.0.1', port: echo.port },
        },
      ],
    });
    await tunnel.connect();
    const conn = await openConnection(listenPort);
    assert.equal(await conn.send('a'), 'drop:a');
    const dead = waitForSocketDeath(conn.socket, 5000);
    bench.dropConnections();
    await dead;
    await assert.rejects(() => conn.send('b'));
    conn.close();
  });

  describe('with reconnect disabled', function () {
    it('closes the local listener instead of black-holing clients', async function () {
      const listenPort = await freePort();
      tunnel = makeTunnel({
        reconnect: { enabled: false },
        localForwards: [
          {
            id: 'svc',
            listen: { host: '127.0.0.1', port: listenPort },
            target: { host: '127.0.0.1', port: echo.port },
          },
        ],
      });
      await tunnel.connect();
      const failed = waitEvent(tunnel, 'state', (e) => e.current === 'failed');
      bench.dropConnections();
      await failed;

      const started = Date.now();
      const outcome = await new Promise((resolve) => {
        const socket = net.connect(listenPort, '127.0.0.1');
        const timer = setTimeout(() => {
          socket.destroy();
          resolve('timeout');
        }, 2000);
        socket.once('error', (err) => {
          clearTimeout(timer);
          resolve(err.code || 'error');
        });
        socket.once('connect', () => {
          socket.once('close', () => {
            clearTimeout(timer);
            resolve('accepted-then-closed');
          });
          socket.once('error', () => {
            clearTimeout(timer);
            resolve('accepted-then-error');
          });
          socket.write('x');
        });
      });
      assert.notEqual(outcome, 'timeout', 'must not black-hole');
      assert.ok(Date.now() - started < 2000);
    });

    it('reports the forward as failed with a transport-level error code', async function () {
      const listenPort = await freePort();
      const errors = [];
      tunnel = makeTunnel({
        reconnect: { enabled: false },
        localForwards: [
          {
            id: 'svc',
            listen: { host: '127.0.0.1', port: listenPort },
            target: { host: '127.0.0.1', port: echo.port },
          },
        ],
      });
      tunnel.on('error', (err) => errors.push(err));
      await tunnel.connect();
      const failed = waitEvent(tunnel, 'state', (e) => e.current === 'failed');
      bench.dropConnections();
      await failed;
      const fwd = tunnel.getForwardStatus('svc');
      assert.ok(fwd.state === 'failed' || fwd.state === 'degraded' || fwd.state === 'closed');
      assert.ok(
        errors.some((e) => e.code === 'TRANSPORT_NOT_READY') ||
          /transport/i.test(fwd.error || tunnel.getStatus().error || ''),
        'transport-level error must be visible',
      );
    });

    it('tears down in-flight client sockets promptly', async function () {
      const listenPort = await freePort();
      tunnel = makeTunnel({
        reconnect: { enabled: false },
        localForwards: [
          {
            id: 'svc',
            listen: { host: '127.0.0.1', port: listenPort },
            target: { host: '127.0.0.1', port: echo.port },
          },
        ],
      });
      await tunnel.connect();
      const held = await hold(listenPort);
      const dead = waitForSocketDeath(held.socket, 5000);
      bench.dropConnections();
      await dead;
      held.close();
    });
  });

  describe('with reconnect enabled', function () {
    it('marks forwards unavailable and refuses traffic while reconnecting', async function () {
      const listenPort = await freePort();
      tunnel = makeTunnel({
        reconnect: { enabled: true, initialDelayMs: 200, maxDelayMs: 400, maxAttempts: 8 },
        localForwards: [
          {
            id: 'svc',
            listen: { host: '127.0.0.1', port: listenPort },
            target: { host: '127.0.0.1', port: echo.port },
          },
        ],
      });
      await tunnel.connect();
      const reconnecting = waitEvent(tunnel, 'state', (e) => e.current === 'reconnecting');
      bench.dropConnections();
      await reconnecting;
      assert.equal(tunnel.getForwardStatus('svc').state, 'degraded');
      await assert.rejects(() => roundTrip(listenPort, 'nope'));
      await waitEvent(tunnel, 'ready');
    });

    it('uses bounded backoff rather than a reconnect storm', async function () {
      const deadPort = await freePort();
      tunnel = new SSHTunnel({
        transport: {
          endpoint: { host: '127.0.0.1', port: deadPort },
          username: 'tester',
          privateKey: credential.inline(bench.clientKey.private),
        },
        reconnect: { enabled: true, initialDelayMs: 80, maxDelayMs: 160, maxAttempts: 3 },
      });
      const count = countReconnects(tunnel);
      const t0 = Date.now();
      const exhausted = waitEvent(tunnel, 'error', (e) => e.code === 'RECONNECT_EXHAUSTED');
      await tunnel.connect();
      await exhausted;
      const elapsed = Date.now() - t0;
      assert.ok(count() <= 3, `reconnect storm: ${count()} attempts`);
      assert.ok(elapsed >= 80, 'backoff should delay retries');
    });

    it('recovers to listening and carries traffic after the SSH server returns', async function () {
      const listenPort = await freePort();
      tunnel = makeTunnel({
        reconnect: { enabled: true, initialDelayMs: 80, maxDelayMs: 200, maxAttempts: 8 },
        localForwards: [
          {
            id: 'svc',
            listen: { host: '127.0.0.1', port: listenPort },
            target: { host: '127.0.0.1', port: echo.port },
          },
        ],
      });
      await tunnel.connect();
      const ready = waitEvent(tunnel, 'ready');
      bench.dropConnections();
      await ready;
      assert.equal(await roundTrip(listenPort, 'back'), 'drop:back');
    });

    it('stops retrying after maxAttempts and fails closed', async function () {
      const deadPort = await freePort();
      tunnel = new SSHTunnel({
        transport: {
          endpoint: { host: '127.0.0.1', port: deadPort },
          username: 'tester',
          privateKey: credential.inline(bench.clientKey.private),
        },
        reconnect: { enabled: true, initialDelayMs: 40, maxDelayMs: 80, maxAttempts: 2 },
      });
      const exhausted = waitEvent(tunnel, 'error', (e) => e.code === 'RECONNECT_EXHAUSTED');
      await tunnel.connect();
      await exhausted;
      assert.equal(tunnel.getState(), 'failed');
    });
  });
});

describe('failure: remote target service stops, restarts or misbehaves', function () {
  let bench;
  let tunnel;

  before(async function () {
    bench = new FaultySSHTestBench();
    await bench.start();
  });

  after(async function () {
    await bench.stop();
  });

  afterEach(async function () {
    if (tunnel) {
      await tunnel.close();
      tunnel = undefined;
    }
  });

  function makeTunnel(overrides) {
    return new SSHTunnel({
      transport: {
        endpoint: { host: '127.0.0.1', port: bench.port },
        username: 'tester',
        privateKey: credential.inline(bench.clientKey.private),
      },
      reconnect: { enabled: false },
      ...overrides,
    });
  }

  it('survives a target restart and serves new connections on the same local port', async function () {
    const target = new RestartableService('tgt:');
    await target.start();
    const listenPort = await freePort();
    tunnel = makeTunnel({
      localForwards: [
        {
          id: 'db',
          listen: { host: '127.0.0.1', port: listenPort },
          target: { host: '127.0.0.1', port: target.port },
        },
      ],
    });
    await tunnel.connect();
    assert.equal(await roundTrip(listenPort, 'a'), 'tgt:a');
    const bound = listenPort;
    await target.stop();
    await target.start(target.port);
    assert.equal(await roundTrip(bound, 'b'), 'tgt:b');
    await target.stop();
  });

  it('kills existing client connections when the target crashes', async function () {
    const target = new RestartableService('tgt:');
    await target.start();
    const listenPort = await freePort();
    tunnel = makeTunnel({
      localForwards: [
        {
          id: 'db',
          listen: { host: '127.0.0.1', port: listenPort },
          target: { host: '127.0.0.1', port: target.port },
        },
      ],
    });
    await tunnel.connect();
    const held = await hold(listenPort);
    held.write('ping');
    const death = waitForSocketDeath(held.socket, 5000);
    await target.stop();
    await death;
    held.close();
  });

  it('fails new connections promptly while the target is down, without dropping the transport', async function () {
    const target = new RestartableService('tgt:');
    await target.start();
    const listenPort = await freePort();
    tunnel = makeTunnel({
      localForwards: [
        {
          id: 'db',
          listen: { host: '127.0.0.1', port: listenPort },
          target: { host: '127.0.0.1', port: target.port },
        },
      ],
    });
    await tunnel.connect();
    await target.stop();
    const t0 = Date.now();
    await assert.rejects(() => roundTrip(listenPort, 'x'));
    assert.ok(Date.now() - t0 < 4000);
    assert.equal(tunnel.getState(), 'ready');
  });

  it('recovers automatically when the target comes back', async function () {
    const target = new RestartableService('tgt:');
    await target.start();
    const listenPort = await freePort();
    tunnel = makeTunnel({
      localForwards: [
        {
          id: 'db',
          listen: { host: '127.0.0.1', port: listenPort },
          target: { host: '127.0.0.1', port: target.port },
        },
      ],
    });
    await tunnel.connect();
    await target.stop();
    await target.start(target.port);
    assert.equal(await roundTrip(listenPort, 'ok'), 'tgt:ok');
    await target.stop();
  });

  it('surfaces a graceful target shutdown as a closed client connection', async function () {
    const target = new RestartableService('tgt:');
    await target.start();
    const listenPort = await freePort();
    tunnel = makeTunnel({
      localForwards: [
        {
          id: 'db',
          listen: { host: '127.0.0.1', port: listenPort },
          target: { host: '127.0.0.1', port: target.port },
        },
      ],
    });
    await tunnel.connect();
    const held = await hold(listenPort);
    const death = waitForSocketDeath(held.socket, 5000);
    await target.stop();
    await death;
    held.close();
  });

  it('does not mask a wedged target as success', async function () {
    const wedge = new BlackHoleTarget();
    await wedge.start();
    const listenPort = await freePort();
    tunnel = makeTunnel({
      localForwards: [
        {
          id: 'wedge',
          listen: { host: '127.0.0.1', port: listenPort },
          target: { host: '127.0.0.1', port: wedge.port },
        },
      ],
    });
    await tunnel.connect();
    await assert.rejects(() => roundTrip(listenPort, 'hello'));
    assert.equal(tunnel.getState(), 'ready');
    await wedge.stop();
  });

  it('passes a slow target through without corrupting the stream', async function () {
    const server = net.createServer((socket) => {
      socket.on('data', (chunk) => {
        setTimeout(() => socket.write(`slow:${chunk}`), 150);
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const listenPort = await freePort();
    tunnel = makeTunnel({
      localForwards: [
        {
          id: 'slow',
          listen: { host: '127.0.0.1', port: listenPort },
          target: { host: '127.0.0.1', port },
        },
      ],
    });
    await tunnel.connect();
    assert.equal(await roundTrip(listenPort, 'xyz'), 'slow:xyz');
    await new Promise((resolve) => server.close(resolve));
  });
});

describe('multiple forwards share one transport without coupling', function () {
  let bench;
  let tunnel;
  let db;
  let http;

  before(async function () {
    bench = new FaultySSHTestBench();
    await bench.start();
    db = new RestartableService('mdb:');
    http = new RestartableService('http:');
    await db.start();
    await http.start();
  });

  after(async function () {
    if (tunnel) await tunnel.close();
    await db.stop();
    await http.stop();
    await bench.stop();
  });

  afterEach(async function () {
    if (tunnel) {
      await tunnel.close();
      tunnel = undefined;
    }
  });

  async function twoForwards() {
    const dbListen = await freePort();
    const httpListen = await freePort();
    const t = new SSHTunnel({
      transport: {
        endpoint: { host: '127.0.0.1', port: bench.port },
        username: 'tester',
        privateKey: credential.inline(bench.clientKey.private),
      },
      reconnect: { enabled: false },
      localForwards: [
        {
          id: 'mariadb',
          listen: { host: '127.0.0.1', port: dbListen },
          target: { host: '127.0.0.1', port: db.port },
        },
        {
          id: 'home-assistant',
          listen: { host: '127.0.0.1', port: httpListen },
          target: { host: '127.0.0.1', port: http.port },
        },
      ],
    });
    return { t, dbListen, httpListen };
  }

  it('opens a single transport for both forwards', async function () {
    const { t, dbListen, httpListen } = await twoForwards();
    tunnel = t;
    const status = await tunnel.connect();
    assert.equal(status.state, 'ready');
    assert.equal(status.forwards.length, 2);
    assert.equal(await roundTrip(dbListen, '1'), 'mdb:1');
    assert.equal(await roundTrip(httpListen, '2'), 'http:2');
  });

  it('carries concurrent traffic on both forwards independently', async function () {
    const { t, dbListen, httpListen } = await twoForwards();
    tunnel = t;
    await tunnel.connect();
    const [a, b] = await Promise.all([
      roundTrip(dbListen, 'db'),
      roundTrip(httpListen, 'web'),
    ]);
    assert.equal(a, 'mdb:db');
    assert.equal(b, 'http:web');
  });

  it('keeps one forward healthy when the other target dies', async function () {
    const { t, dbListen, httpListen } = await twoForwards();
    tunnel = t;
    await tunnel.connect();
    await db.stop();
    await assert.rejects(() => roundTrip(dbListen, 'x'));
    assert.equal(await roundTrip(httpListen, 'still'), 'http:still');
    await db.start(db.port);
  });

  it('exposes only an explicit openUrl, and only for forwards that have one', async function () {
    const { t, dbListen } = await twoForwards();
    tunnel = t;
    await tunnel.connect();
    assert.equal(typeof tunnel.openUrl, 'undefined');
    const resolved = tunnel.resolveEndpoint('mariadb');
    assert.equal(resolved.endpoint.host, '127.0.0.1');
    assert.equal(resolved.endpoint.port, dbListen);
    assert.throws(() => tunnel.resolveEndpoint('nope'));
  });

  it('honours enabled:false without binding a port', async function () {
    const listenPort = await freePort();
    tunnel = new SSHTunnel({
      transport: {
        endpoint: { host: '127.0.0.1', port: bench.port },
        username: 'tester',
        privateKey: credential.inline(bench.clientKey.private),
      },
      reconnect: { enabled: false },
      localForwards: [],
    });
    await tunnel.connect();
    const probe = net.createServer();
    await new Promise((resolve, reject) => {
      probe.once('error', reject);
      probe.listen(listenPort, '127.0.0.1', resolve);
    });
    probe.close();
  });

  it('releases both listeners on stop', async function () {
    const { t, dbListen, httpListen } = await twoForwards();
    tunnel = t;
    await tunnel.connect();
    await tunnel.close();
    tunnel = undefined;
    await assert.rejects(() => roundTrip(dbListen, 'x'));
    await assert.rejects(() => roundTrip(httpListen, 'x'));
  });

  it('is idempotent on repeated stop calls', async function () {
    const { t } = await twoForwards();
    tunnel = t;
    await tunnel.connect();
    await tunnel.close();
    await tunnel.close();
    await tunnel.close();
    assert.equal(tunnel.getState(), 'closed');
    tunnel = undefined;
  });
});

describe('security: local listeners are loopback-only', function () {
  let bench;
  let echo;
  let tunnel;

  before(async function () {
    bench = new FaultySSHTestBench();
    await bench.start();
    echo = new EchoServer('sec:');
    await echo.start();
  });

  after(async function () {
    if (tunnel) await tunnel.close();
    await echo.stop();
    await bench.stop();
  });

  afterEach(async function () {
    if (tunnel) {
      await tunnel.close();
      tunnel = undefined;
    }
  });

  it('binds exactly 127.0.0.1, not the unspecified address', async function () {
    const listenPort = await freePort();
    tunnel = new SSHTunnel({
      transport: {
        endpoint: { host: '127.0.0.1', port: bench.port },
        username: 'tester',
        privateKey: credential.inline(bench.clientKey.private),
      },
      reconnect: { enabled: false },
      localForwards: [
        {
          id: 'loop',
          listen: { host: '127.0.0.1', port: listenPort },
          target: { host: '127.0.0.1', port: echo.port },
        },
      ],
    });
    await tunnel.connect();
    const status = tunnel.getForwardStatus('loop');
    assert.equal(status.listen.host, '127.0.0.1');
    assert.notEqual(status.listen.host, '0.0.0.0');
  });

  it('is reachable on 127.0.0.1', async function () {
    const listenPort = await freePort();
    tunnel = new SSHTunnel({
      transport: {
        endpoint: { host: '127.0.0.1', port: bench.port },
        username: 'tester',
        privateKey: credential.inline(bench.clientKey.private),
      },
      reconnect: { enabled: false },
      localForwards: [
        {
          id: 'loop',
          listen: { host: '127.0.0.1', port: listenPort },
          target: { host: '127.0.0.1', port: echo.port },
        },
      ],
    });
    await tunnel.connect();
    assert.equal(await roundTrip(listenPort, 'hi', '127.0.0.1'), 'sec:hi');
  });

  it("is NOT reachable via this host's own LAN address", async function () {
    const lan = firstNonLoopbackIPv4();
    if (!lan) {
      this.skip();
      return;
    }
    const listenPort = await freePort();
    tunnel = new SSHTunnel({
      transport: {
        endpoint: { host: '127.0.0.1', port: bench.port },
        username: 'tester',
        privateKey: credential.inline(bench.clientKey.private),
      },
      reconnect: { enabled: false },
      localForwards: [
        {
          id: 'loop',
          listen: { host: '127.0.0.1', port: listenPort },
          target: { host: '127.0.0.1', port: echo.port },
        },
      ],
    });
    await tunnel.connect();
    await assert.rejects(() => connectDeadline(listenPort, lan, 500));
  });

  it('has a defined IPv6 policy for the ::1 loopback', async function () {
    const spec = validateLocalForward({
      listen: { host: '::1', port: 8280 },
      target: { host: '127.0.0.1', port: 8080 },
    });
    assert.equal(spec.listen.host, '::1');
  });

  it('refuses a non-loopback bind unless policy explicitly allows it', async function () {
    const lan = firstNonLoopbackIPv4() || '192.168.1.50';
    assert.throws(() => {
      validateLocalForward(
        {
          listen: { host: lan, port: 8280 },
          target: { host: '127.0.0.1', port: 8080 },
        },
        { allowedRemoteHosts: ['127.0.0.1'] },
      );
    });
  });

  it('optional: unreachable from a separate network namespace', function () {
    this.skip();
  });
});

describe('security: allowed-target policy is enforced', function () {
  const policy = {
    allowedRemoteHosts: ['127.0.0.1'],
    allowedRemoteTargetPorts: [3306, 8080],
  };

  function reject(forward) {
    assert.throws(() => validateLocalForward(forward, policy), (err) => {
      return err.code === 'HOST_NOT_PERMITTED' || err.code === 'PORT_NOT_PERMITTED' || err.code === 'INVALID_FORWARD_SPEC';
    });
  }

  it('rejects a different port on an allowed host (SSH)', function () {
    reject({
      listen: { host: '127.0.0.1', port: 8222 },
      target: { host: '127.0.0.1', port: 22 },
    });
  });

  it('rejects an unlisted host on the same subnet', function () {
    reject({
      listen: { host: '127.0.0.1', port: 8222 },
      target: { host: '192.168.1.20', port: 3306 },
    });
  });

  it('rejects a host on a different private subnet', function () {
    reject({
      listen: { host: '127.0.0.1', port: 8222 },
      target: { host: '10.0.0.5', port: 3306 },
    });
  });

  it('rejects the gateway loopback', function () {
    reject({
      listen: { host: '127.0.0.1', port: 8222 },
      target: { host: '192.168.1.1', port: 3306 },
    });
  });

  it('rejects the unspecified address', function () {
    reject({
      listen: { host: '127.0.0.1', port: 8222 },
      target: { host: '0.0.0.0', port: 3306 },
    });
  });

  it('rejects IPv6 loopback', function () {
    reject({
      listen: { host: '127.0.0.1', port: 8222 },
      target: { host: '::1', port: 3306 },
    });
  });

  it('rejects a public internet host', function () {
    reject({
      listen: { host: '127.0.0.1', port: 8222 },
      target: { host: '8.8.8.8', port: 3306 },
    });
  });

  it('rejects a denied target before opening any SSH transport', async function () {
    const tunnel = new SSHTunnel({
      transport: {
        endpoint: { host: '127.0.0.1', port: 1 },
        username: 'x',
        privateKey: credential.inline('not-a-key'),
      },
      portPolicy: policy,
      reconnect: { enabled: false },
    });
    try {
      await assert.rejects(
        () =>
          tunnel.addLocalForward({
            id: 'nope',
            listen: { host: '127.0.0.1', port: 18080 },
            target: { host: '8.8.8.8', port: 3306 },
          }),
        (err) => err.code === 'HOST_NOT_PERMITTED' || err.code === 'TRANSPORT_NOT_READY',
      );
      assert.equal(tunnel.getState(), 'idle');
    } finally {
      await tunnel.close();
    }
  });

  it('accepts an explicitly allowed host and port', function () {
    const spec = validateLocalForward(
      {
        listen: { host: '127.0.0.1', port: 8330 },
        target: { host: '127.0.0.1', port: 3306 },
      },
      policy,
    );
    assert.equal(spec.target.port, 3306);
  });

  it('treats an absent allowlist as the general-purpose library default', function () {
    const spec = validateLocalForward({
      listen: { host: '127.0.0.1', port: 8400 },
      target: { host: '10.1.2.3', port: 8080 },
    });
    assert.equal(spec.target.host, '10.1.2.3');
  });

  it('rejects a forward with a missing or malformed target', function () {
    assert.throws(() =>
      validateLocalForward({
        listen: { host: '127.0.0.1', port: 8400 },
        target: { host: '', port: 8080 },
      }),
    );
    assert.throws(() =>
      validateLocalForward({
        listen: { host: '127.0.0.1', port: 8400 },
        target: { host: '127.0.0.1', port: -1 },
      }),
    );
  });
});

describe('lifecycle: signals, parent exit and crash', function () {
  let bench;
  let echo;
  let keyPath;

  before(async function () {
    bench = new FaultySSHTestBench();
    await bench.start();
    echo = new EchoServer('life:');
    await echo.start();
    const dir = mkdtempSync(join(tmpdir(), 'sshtun-life-'));
    keyPath = join(dir, 'id_ed25519');
    writeFileSync(keyPath, bench.clientKey.private, { mode: 0o600 });
  });

  after(async function () {
    await echo.stop();
    await bench.stop();
  });

  function startCli(listenPort, extraArgs = []) {
    const child = spawn(
      process.execPath,
      [
        CLI,
        'tester@127.0.0.1',
        '-p',
        String(bench.port),
        '-i',
        keyPath,
        '-L',
        `${listenPort}:127.0.0.1:${echo.port}`,
        '--no-reconnect',
        ...extraArgs,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const up = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`CLI never came up:\n${stderr}`)), 12000);
      const onData = () => {
        if (stderr.includes('tunnel is up')) {
          clearTimeout(timer);
          resolve();
        }
      };
      child.stderr.on('data', onData);
      child.once('close', (code) => {
        clearTimeout(timer);
        reject(new Error(`CLI exited early ${code}:\n${stderr}`));
      });
    });
    return { child, up, get stderr() { return stderr; } };
  }

  async function signalReleases(signal) {
    const listenPort = await freePort();
    const cli = startCli(listenPort);
    await cli.up;
    const exited = new Promise((resolve) => cli.child.once('close', resolve));
    cli.child.kill(signal);
    await exited;
    await assert.rejects(() => roundTrip(listenPort, 'after'));
  }

  it('shuts down deterministically on SIGINT', async function () {
    await signalReleases('SIGINT');
  });

  it('shuts down deterministically on SIGTERM', async function () {
    await signalReleases('SIGTERM');
  });

  it('shuts down deterministically on SIGHUP', async function () {
    await signalReleases('SIGHUP');
  });

  it('releases the port on SIGKILL even though no cleanup handler runs', async function () {
    const listenPort = await freePort();
    const cli = startCli(listenPort);
    await cli.up;
    const exited = new Promise((resolve) => cli.child.once('close', resolve));
    cli.child.kill('SIGKILL');
    await exited;
    const rebound = net.createServer();
    await new Promise((resolve, reject) => {
      rebound.once('error', reject);
      rebound.listen(listenPort, '127.0.0.1', resolve);
    });
    rebound.close();
  });

  it('allows a fresh instance to rebind the port after an ungraceful death', async function () {
    const listenPort = await freePort();
    const first = startCli(listenPort);
    await first.up;
    const exited = new Promise((resolve) => first.child.once('close', resolve));
    first.child.kill('SIGKILL');
    await exited;
    const second = startCli(listenPort);
    await second.up;
    assert.equal(await roundTrip(listenPort, 'reborn'), 'life:reborn');
    const done = new Promise((resolve) => second.child.once('close', resolve));
    second.child.kill('SIGINT');
    await done;
  });

  it('does not linger as an orphan when its parent dies (--exit-with-parent)', async function () {
    const listenPort = await freePort();
    const wrapper = `
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ${JSON.stringify([
        CLI,
        'tester@127.0.0.1',
        '-p',
        String(bench.port),
        '-i',
        keyPath,
        '-L',
        `${listenPort}:127.0.0.1:${echo.port}`,
        '--no-reconnect',
      ])}, { stdio: ['ignore', 'ignore', 'pipe'] });
      child.stderr.on('data', (chunk) => process.stderr.write(chunk));
      process.on('SIGTERM', () => { child.kill('SIGKILL'); process.exit(0); });
      setInterval(() => {}, 10000);
    `;
    const parent = spawn(process.execPath, ['-e', wrapper], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    parent.stderr.on('data', (c) => {
      stderr += c;
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`parent never up:\n${stderr}`)), 12000);
      parent.stderr.on('data', () => {
        if (stderr.includes('tunnel is up')) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    const parentDead = new Promise((resolve) => parent.once('close', resolve));
    parent.kill('SIGTERM');
    await parentDead;
    await new Promise((r) => setTimeout(r, 300));
    await assert.rejects(() => roundTrip(listenPort, 'orphan'));
  });

  it('reports a startup failure and exits non-zero rather than hanging', async function () {
    const dead = await freePort();
    const child = spawn(
      process.execPath,
      [
        CLI,
        'tester@127.0.0.1',
        '-p',
        String(dead),
        '-i',
        keyPath,
        '-L',
        `1:127.0.0.1:${echo.port}`,
        '--no-reconnect',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('startup hung'));
      }, 8000);
      child.once('close', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    assert.notEqual(result, 0);
  });

  it('releases resources after an uncaught crash', async function () {
    const listenPort = await freePort();
    const cli = startCli(listenPort);
    await cli.up;
    const exited = new Promise((resolve) => cli.child.once('close', resolve));
    cli.child.kill('SIGKILL');
    await exited;
    const rebound = net.createServer();
    await new Promise((resolve, reject) => {
      rebound.once('error', reject);
      rebound.listen(listenPort, '127.0.0.1', resolve);
    });
    rebound.close();
  });
});

describe('adverse conditions', function () {
  let bench;
  let echo;
  let tunnel;

  before(async function () {
    bench = new FaultySSHTestBench();
    await bench.start();
    echo = new EchoServer('adv:');
    await echo.start();
  });

  after(async function () {
    if (tunnel) await tunnel.close();
    await echo.stop();
    await bench.stop();
  });

  afterEach(async function () {
    if (tunnel) {
      await tunnel.close();
      tunnel = undefined;
    }
    bench.setFault('rejectDirectTcpip', false);
    bench.setFault('delayDirectTcpipMs', 0);
  });

  it('times out an endpoint that accepts TCP but never completes the handshake', async function () {
    this.timeout(4000);
    const accepted = [];
    const hole = net.createServer((socket) => {
      accepted.push(socket);
      socket.on('error', () => socket.destroy());
    });
    await new Promise((resolve) => hole.listen(0, '127.0.0.1', resolve));
    const port = hole.address().port;
    tunnel = new SSHTunnel({
      transport: {
        endpoint: { host: '127.0.0.1', port },
        username: 'tester',
        privateKey: credential.inline(bench.clientKey.private),
        readyTimeoutMs: 250,
      },
      reconnect: { enabled: false },
    });
    tunnel.on('error', () => {});

    const connectOutcome = tunnel.connect().then(
      (status) => ({ kind: 'resolved', status }),
      (err) => ({ kind: 'rejected', err }),
    );
    setTimeout(() => {
      for (const socket of accepted) {
        try {
          socket.destroy();
        } catch {
          /* ignore */
        }
      }
    }, 80);

    const outcome = await Promise.race([
      connectOutcome,
      new Promise((resolve) => setTimeout(() => resolve({ kind: 'hung' }), 1500)),
    ]);

    assert.notEqual(outcome.kind, 'hung', 'connect() must settle when the peer never speaks SSH');
    assert.equal(outcome.kind, 'rejected');
    assert.equal(outcome.err.code, 'TRANSPORT_NOT_READY');

    try {
      await tunnel.close();
    } catch {
      /* ignore */
    }
    tunnel = undefined;
    for (const socket of accepted) socket.destroy();
    await new Promise((resolve) => hole.close(resolve));
  });

  it('reports a refused channel open without claiming transport failure', async function () {
    bench.setFault('rejectDirectTcpip', true);
    const listenPort = await freePort();
    const errors = [];
    tunnel = new SSHTunnel({
      transport: {
        endpoint: { host: '127.0.0.1', port: bench.port },
        username: 'tester',
        privateKey: credential.inline(bench.clientKey.private),
      },
      reconnect: { enabled: false },
      localForwards: [
        {
          id: 'ch',
          listen: { host: '127.0.0.1', port: listenPort },
          target: { host: '127.0.0.1', port: echo.port },
        },
      ],
    });
    tunnel.on('error', (err) => errors.push(err));
    await tunnel.connect();
    await assert.rejects(() => roundTrip(listenPort, 'x'));
    assert.equal(tunnel.getState(), 'ready');
    assert.ok(errors.every((e) => e.code !== 'RECONNECT_EXHAUSTED'));
  });

  it('tolerates slow channel setup without corrupting the stream', async function () {
    bench.setFault('delayDirectTcpipMs', 120);
    const listenPort = await freePort();
    tunnel = new SSHTunnel({
      transport: {
        endpoint: { host: '127.0.0.1', port: bench.port },
        username: 'tester',
        privateKey: credential.inline(bench.clientKey.private),
      },
      reconnect: { enabled: false },
      localForwards: [
        {
          id: 'slowch',
          listen: { host: '127.0.0.1', port: listenPort },
          target: { host: '127.0.0.1', port: echo.port },
        },
      ],
    });
    await tunnel.connect();
    assert.equal(await roundTrip(listenPort, 'abc'), 'adv:abc');
  });

  it('survives clients hammering the port during a transport flap without leaking listeners', async function () {
    const listenPort = await freePort();
    tunnel = new SSHTunnel({
      transport: {
        endpoint: { host: '127.0.0.1', port: bench.port },
        username: 'tester',
        privateKey: credential.inline(bench.clientKey.private),
      },
      reconnect: { enabled: true, initialDelayMs: 80, maxDelayMs: 200, maxAttempts: 8 },
      localForwards: [
        {
          id: 'hammer',
          listen: { host: '127.0.0.1', port: listenPort },
          target: { host: '127.0.0.1', port: echo.port },
        },
      ],
    });
    await tunnel.connect();
    tunnel.on('error', () => {});

    const sockets = [];
    bench.dropConnections();

    for (let i = 0; i < 40; i += 1) {
      const socket = net.connect(listenPort, '127.0.0.1');
      sockets.push(socket);
      socket.on('error', () => {});
      socket.write('x');
    }

    await waitFor(
      () =>
        sockets.every((s) => s.destroyed || s.readyState === 'closed') &&
        tunnel.listConnections().length === 0,
      { timeoutMs: 8000, label: 'hammer requests to settle' },
    );

    await waitFor(() => tunnel.getState() === 'ready', {
      timeoutMs: 8000,
      label: 'transport ready after flap',
    });
    assert.equal(await roundTrip(listenPort, 'after-flap'), 'adv:after-flap');
    for (const socket of sockets) socket.destroy();
  });

  it('drains and closes cleanly while traffic is in flight', async function () {
    const listenPort = await freePort();
    tunnel = new SSHTunnel({
      transport: {
        endpoint: { host: '127.0.0.1', port: bench.port },
        username: 'tester',
        privateKey: credential.inline(bench.clientKey.private),
      },
      reconnect: { enabled: false },
      localForwards: [
        {
          id: 'drain',
          listen: { host: '127.0.0.1', port: listenPort },
          target: { host: '127.0.0.1', port: echo.port },
        },
      ],
    });
    await tunnel.connect();
    const held = await hold(listenPort);
    await tunnel.close();
    tunnel = undefined;
    await waitForSocketDeath(held.socket, 5000);
    held.close();
  });

  it('handles a large payload through the tunnel without truncation', async function () {
    const raw = net.createServer((socket) => {
      socket.on('data', (chunk) => socket.write(chunk));
      socket.on('error', () => socket.destroy());
    });
    await new Promise((resolve) => raw.listen(0, '127.0.0.1', resolve));
    const rawPort = raw.address().port;
    const listenPort = await freePort();
    tunnel = new SSHTunnel({
      transport: {
        endpoint: { host: '127.0.0.1', port: bench.port },
        username: 'tester',
        privateKey: credential.inline(bench.clientKey.private),
      },
      reconnect: { enabled: false },
      localForwards: [
        {
          id: 'big',
          listen: { host: '127.0.0.1', port: listenPort },
          target: { host: '127.0.0.1', port: rawPort },
        },
      ],
    });
    await tunnel.connect();
    const payload = Buffer.alloc(64 * 1024, 0x5a);
    const socket = net.connect(listenPort, '127.0.0.1');
    const chunks = [];
    const received = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('large payload timed out')), 8000);
      socket.on('data', (c) => {
        chunks.push(c);
        const body = Buffer.concat(chunks);
        if (body.length >= payload.length) {
          clearTimeout(timer);
          resolve(body);
        }
      });
      socket.on('error', reject);
    });
    socket.write(payload);
    const body = await received;
    assert.equal(body.subarray(0, payload.length).compare(payload), 0);
    socket.destroy();
    await new Promise((resolve) => raw.close(resolve));
  });
});
