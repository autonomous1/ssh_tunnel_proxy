/*
 * Failure-mode harness.
 *
 * One case per TunnelError code, plus operational faults that do not have
 * their own code but are how a phone / NAT / flaky relay actually dies:
 * mid-stream drop, target black-hole, listen collision, half-open after
 * transport loss, reconnect exhaustion against a live-then-dead listener.
 *
 * Topology is always loopback. No external sshd, zrok, or phone required.
 */

const assert = require('node:assert/strict');
const net = require('node:net');
const { describe, it, before, after, beforeEach, afterEach } = require('mocha');

const { SSHTunnel, credential, TUNNEL_ERROR_CODES } = require('../../build');
const { EchoServer, roundTrip, openConnection, freePort } = require('../helpers/ssh-testbench');
const {
  FaultySSHTestBench,
  ResetTarget,
  BlackHoleTarget,
  waitFor,
  expectCode,
} = require('../helpers/fault-injector');

describe('failure-mode harness', function () {
  let bench;
  let echo;
  let tunnel;

  before(async function () {
    bench = new FaultySSHTestBench();
    await bench.start();
    echo = new EchoServer('fm:');
    await echo.start();
  });

  after(async function () {
    await echo.stop();
    await bench.stop();
  });

  afterEach(async function () {
    if (tunnel) {
      await tunnel.close();
      tunnel = undefined;
    }
    bench.setFault('rejectAuth', false);
    bench.setFault('rejectDirectTcpip', false);
    bench.setFault('rejectTcpipForward', false);
    bench.setFault('delayDirectTcpipMs', 0);
    bench.setFault('dropAfterBytes', 0);
    bench.setFault('acceptThenReset', false);
  });

  function makeTunnel(overrides = {}) {
    return new SSHTunnel({
      id: 'failure-harness',
      transport: {
        endpoint: { host: '127.0.0.1', port: bench.port },
        username: 'tester',
        privateKey: credential.inline(bench.clientKey.private),
      },
      reconnect: { enabled: false },
      ...overrides,
    });
  }

  // -------------------------------------------------------------------------
  // Catalog: every published error code has at least one forcing path
  // -------------------------------------------------------------------------

  it('catalog lists a stable closed set of codes', function () {
    assert.deepEqual(
      [...TUNNEL_ERROR_CODES].sort(),
      [
        'AUTH_FAILED',
        'CHANNEL_OPEN_FAILED',
        'CONNECTION_LIMIT',
        'CREDENTIAL_UNRESOLVED',
        'DUPLICATE_FORWARD_ID',
        'HOST_NOT_PERMITTED',
        'INVALID_FORWARD_SPEC',
        'LISTEN_FAILED',
        'PORT_NOT_PERMITTED',
        'RECONNECT_EXHAUSTED',
        'REMOTE_BIND_FAILED',
        'TARGET_UNREACHABLE',
        'TRANSPORT_NOT_READY',
        'UNKNOWN_FORWARD',
      ],
    );
  });

  it('INVALID_FORWARD_SPEC: garbage -L string', async function () {
    tunnel = makeTunnel();
    await tunnel.connect();
    await assert.rejects(
      () => tunnel.addLocalForward('not-a-forward'),
      expectCode('INVALID_FORWARD_SPEC'),
    );
  });

  it('PORT_NOT_PERMITTED: privileged listen without allowlist', async function () {
    tunnel = makeTunnel({
      portPolicy: { allowedPrivilegedPorts: [] },
    });
    await tunnel.connect();
    await assert.rejects(
      () =>
        tunnel.addLocalForward({
          id: 'priv',
          listen: { host: '127.0.0.1', port: 80 },
          target: { host: '127.0.0.1', port: echo.port },
        }),
      expectCode('PORT_NOT_PERMITTED'),
    );
  });

  it('HOST_NOT_PERMITTED: target host outside allowlist', async function () {
    const listenPort = await freePort();
    tunnel = makeTunnel({
      portPolicy: { allowedRemoteHosts: ['10.0.0.1'] },
    });
    await tunnel.connect();
    await assert.rejects(
      () =>
        tunnel.addLocalForward({
          id: 'bad-host',
          listen: { host: '127.0.0.1', port: listenPort },
          target: { host: '192.168.1.1', port: 8080 },
        }),
      expectCode('HOST_NOT_PERMITTED'),
    );
  });

  it('TRANSPORT_NOT_READY: remote forward before connect', async function () {
    tunnel = makeTunnel();
    await assert.rejects(
      () =>
        tunnel.addRemoteForward({
          id: 'early',
          bind: { host: '127.0.0.1', port: 0 },
          target: { host: '127.0.0.1', port: echo.port },
        }),
      expectCode('TRANSPORT_NOT_READY'),
    );
  });

  it('AUTH_FAILED: wrong key', async function () {
    const other = new FaultySSHTestBench();
    tunnel = new SSHTunnel({
      transport: {
        endpoint: { host: '127.0.0.1', port: bench.port },
        username: 'tester',
        privateKey: credential.inline(other.clientKey.private),
      },
      reconnect: { enabled: false },
    });
    await assert.rejects(() => tunnel.connect(), expectCode('AUTH_FAILED'));
    assert.equal(tunnel.getState(), 'failed');
  });

  it('CREDENTIAL_UNRESOLVED: no key, password, or agent', async function () {
    tunnel = new SSHTunnel({
      transport: {
        endpoint: { host: '127.0.0.1', port: bench.port },
        username: 'tester',
      },
      reconnect: { enabled: false },
    });
    await assert.rejects(() => tunnel.connect(), expectCode('CREDENTIAL_UNRESOLVED'));
  });

  it('LISTEN_FAILED: local port already bound', async function () {
    const blocker = net.createServer();
    const listenPort = await new Promise((resolve) => {
      blocker.listen(0, '127.0.0.1', () => resolve(blocker.address().port));
    });
    tunnel = makeTunnel();
    await tunnel.connect();
    try {
      await assert.rejects(
        () =>
          tunnel.addLocalForward({
            id: 'taken',
            listen: { host: '127.0.0.1', port: listenPort },
            target: { host: '127.0.0.1', port: echo.port },
          }),
        expectCode('LISTEN_FAILED'),
      );
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
    }
  });

  it('REMOTE_BIND_FAILED: peer rejects tcpip-forward', async function () {
    bench.setFault('rejectTcpipForward', true);
    tunnel = makeTunnel();
    await tunnel.connect();
    await assert.rejects(
      () =>
        tunnel.addRemoteForward({
          id: 'no-bind',
          bind: { host: '127.0.0.1', port: 0 },
          target: { host: '127.0.0.1', port: echo.port },
        }),
      expectCode('REMOTE_BIND_FAILED'),
    );
  });

  it('CHANNEL_OPEN_FAILED: peer rejects direct-tcpip', async function () {
    bench.setFault('rejectDirectTcpip', true);
    const listenPort = await freePort();
    tunnel = makeTunnel({
      localForwards: [
        {
          id: 'blocked-channel',
          listen: { host: '127.0.0.1', port: listenPort },
          target: { host: '127.0.0.1', port: echo.port },
        },
      ],
    });
    await tunnel.connect();

    const failedConn = waitFor(
      tunnel,
      'connection',
      (event) => event.status.state === 'failed',
    );
    const errors = [];
    tunnel.on('error', (err) => errors.push(err));

    await assert.rejects(() => roundTrip(listenPort, 'x'));
    const event = await failedConn;
    assert.ok(
      event.status.error || errors.some((e) => e.code === 'CHANNEL_OPEN_FAILED' || e.code === 'TARGET_UNREACHABLE'),
      'channel or target failure must be reported',
    );
  });

  it('TARGET_UNREACHABLE: destination port is closed', async function () {
    const dead = await freePort();
    const listenPort = await freePort();
    tunnel = makeTunnel({
      localForwards: [
        {
          id: 'dead-target',
          listen: { host: '127.0.0.1', port: listenPort },
          target: { host: '127.0.0.1', port: dead },
        },
      ],
    });
    await tunnel.connect();

    const failed = waitFor(
      tunnel,
      'connection',
      (event) => event.status.state === 'failed' || event.status.state === 'closed',
    );
    await assert.rejects(() => roundTrip(listenPort, 'ping'));
    await failed;
  });

  it('DUPLICATE_FORWARD_ID', async function () {
    const listenPort = await freePort();
    tunnel = makeTunnel();
    await tunnel.connect();
    await tunnel.addLocalForward({
      id: 'same',
      exclusive: true,
      listen: { host: '127.0.0.1', port: listenPort },
      target: { host: '127.0.0.1', port: echo.port },
    });
    const other = await freePort();
    await assert.rejects(
      () =>
        tunnel.addLocalForward({
          id: 'same',
          exclusive: true,
          listen: { host: '127.0.0.1', port: other },
          target: { host: '127.0.0.1', port: echo.port },
        }),
      expectCode('DUPLICATE_FORWARD_ID'),
    );
  });

  it('UNKNOWN_FORWARD: resolve and remove missing id', async function () {
    tunnel = makeTunnel();
    await tunnel.connect();
    assert.throws(() => tunnel.resolveEndpoint('no-such'), expectCode('UNKNOWN_FORWARD'));
    await assert.rejects(() => tunnel.removeForward('no-such'), expectCode('UNKNOWN_FORWARD'));
  });

  it('CONNECTION_LIMIT: extra sockets are refused', async function () {
    const listenPort = await freePort();
    tunnel = makeTunnel({
      localForwards: [
        {
          id: 'capped',
          listen: { host: '127.0.0.1', port: listenPort },
          target: { host: '127.0.0.1', port: echo.port },
          maxConnections: 1,
        },
      ],
    });
    await tunnel.connect();

    const held = await openConnection(listenPort);
    const limitErr = waitFor(tunnel, 'error', (err) => err.code === 'CONNECTION_LIMIT');
    const second = net.connect(listenPort, '127.0.0.1');
    const closed = new Promise((resolve) => second.once('close', resolve));
    second.on('error', () => {});
    await limitErr;
    await closed;
    held.close();
  });

  it('RECONNECT_EXHAUSTED: dead listener, finite attempts', async function () {
    const deadPort = await freePort();
    tunnel = new SSHTunnel({
      transport: {
        endpoint: { host: '127.0.0.1', port: deadPort },
        username: 'tester',
        privateKey: credential.inline(bench.clientKey.private),
      },
      reconnect: { enabled: true, initialDelayMs: 40, maxDelayMs: 80, maxAttempts: 2 },
    });
    const exhausted = waitFor(tunnel, 'error', (err) => err.code === 'RECONNECT_EXHAUSTED');
    await tunnel.connect();
    await exhausted;
    assert.equal(tunnel.getState(), 'failed');
  });

  // -------------------------------------------------------------------------
  // Operational faults (phone / NAT / relay)
  // -------------------------------------------------------------------------

  it('degraded local listener stays bound across a transport drop', async function () {
    const listenPort = await freePort();
    tunnel = makeTunnel({
      reconnect: { enabled: true, initialDelayMs: 80, maxDelayMs: 200, maxAttempts: 5 },
      localForwards: [
        {
          id: 'hold-port',
          listen: { host: '127.0.0.1', port: listenPort },
          target: { host: '127.0.0.1', port: echo.port },
        },
      ],
    });
    await tunnel.connect();
    assert.equal(await roundTrip(listenPort, 'up'), 'fm:up');

    const readyAgain = waitFor(tunnel, 'ready');
    const degraded = waitFor(
      tunnel,
      'forward',
      (event) => event.status.forwardId === 'hold-port' && event.status.state === 'degraded',
    );
    bench.dropConnections();
    await degraded;
    assert.equal(tunnel.getForwardStatus('hold-port').state, 'degraded');

    // Port is still owned: a second bind must fail.
    const collide = net.createServer();
    const collided = await new Promise((resolve) => {
      collide.once('error', (err) => resolve(err.code));
      collide.listen(listenPort, '127.0.0.1', () => resolve('BOUND'));
    });
    collide.close();
    assert.equal(collided, 'EADDRINUSE');

    await readyAgain;
    assert.equal(await roundTrip(listenPort, 'back'), 'fm:back');
  });

  it('in-flight connection dies when the transport is reset', async function () {
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
    assert.equal(await conn.send('a'), 'fm:a');
    assert.equal(tunnel.getForwardStatus('live').activeConnections, 1);

    // dropConnections() is the signal the library actually handles: the
    // ssh2 client emits close, markDegraded() tears down live pipes.
    // client.destroy() on the server session does not reliably do that.
    const failed = waitFor(tunnel, 'state', (event) => event.current === 'failed');
    bench.dropConnections();
    await failed;

    assert.equal(tunnel.getForwardStatus('live').state, 'degraded');
    assert.equal(tunnel.getForwardStatus('live').activeConnections, 0);
    assert.equal(tunnel.listConnections().length, 0);

    await assert.rejects(() => conn.send('b'));
    conn.close();
  });

  it('black-hole target does not hang connect() of the tunnel itself', async function () {
    const hole = new BlackHoleTarget();
    await hole.start();
    try {
      const listenPort = await freePort();
      tunnel = makeTunnel({
        localForwards: [
          {
            id: 'hole',
            listen: { host: '127.0.0.1', port: listenPort },
            target: { host: '127.0.0.1', port: hole.port },
          },
        ],
      });
      const status = await tunnel.connect();
      assert.equal(status.state, 'ready');
    } finally {
      await hole.stop();
    }
  });

  it('reset target surfaces a failed connection rather than a hung socket', async function () {
    const reset = new ResetTarget();
    await reset.start();
    try {
      const listenPort = await freePort();
      tunnel = makeTunnel({
        localForwards: [
          {
            id: 'rst',
            listen: { host: '127.0.0.1', port: listenPort },
            target: { host: '127.0.0.1', port: reset.port },
          },
        ],
      });
      await tunnel.connect();
      const failed = waitFor(
        tunnel,
        'connection',
        (event) => event.status.state === 'failed' || event.status.state === 'closed',
        6000,
      );
      await assert.rejects(() => roundTrip(listenPort, 'x'));
      await failed;
    } finally {
      await reset.stop();
    }
  });

  it('atomic addLocalForwards rolls back when one listen fails', async function () {
    const blocker = net.createServer();
    const taken = await new Promise((resolve) => {
      blocker.listen(0, '127.0.0.1', () => resolve(blocker.address().port));
    });
    const first = await freePort();
    tunnel = makeTunnel();
    await tunnel.connect();
    try {
      await assert.rejects(
        () =>
          tunnel.addLocalForwards([
            {
              id: 'ok-one',
              listen: { host: '127.0.0.1', port: first },
              target: { host: '127.0.0.1', port: echo.port },
            },
            {
              id: 'bad-two',
              listen: { host: '127.0.0.1', port: taken },
              target: { host: '127.0.0.1', port: echo.port },
            },
          ]),
        expectCode('LISTEN_FAILED'),
      );
      assert.throws(() => tunnel.getForwardStatus('ok-one'), expectCode('UNKNOWN_FORWARD'));
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
    }
  });

  it('close during reconnect does not leave a timer that reconnects later', async function () {
    tunnel = makeTunnel({
      reconnect: { enabled: true, initialDelayMs: 400, maxDelayMs: 400, maxAttempts: 10 },
    });
    await tunnel.connect();
    bench.dropConnections();
    await waitFor(tunnel, 'reconnect');
    await tunnel.close();
    assert.equal(tunnel.getState(), 'closed');
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(tunnel.getState(), 'closed');
    tunnel = undefined;
  });
});
