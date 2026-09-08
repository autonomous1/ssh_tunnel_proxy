/*
 * Transport loss, reconnection and forward re-establishment.
 *
 * This is the behaviour that justifies the package existing at all: ssh2 gives
 * you the primitives, but a mobile or NAT-bound device needs the operational
 * handling around them.
 */

const assert = require('node:assert/strict');
const { describe, it, before, after, beforeEach, afterEach } = require('mocha');

const { SSHTunnel, credential } = require('../../build');
const { SSHTestBench, EchoServer, roundTrip, freePort } = require('../helpers/ssh-testbench');

function waitFor(emitter, event, predicate = () => true, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.off(event, handler);
      reject(new Error(`timed out waiting for "${event}"`));
    }, timeoutMs);
    const handler = (payload) => {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      emitter.off(event, handler);
      resolve(payload);
    };
    emitter.on(event, handler);
  });
}

describe('tunnel lifecycle', function () {
  let bench;
  let echo;
  let tunnel;

  before(async function () {
    bench = new SSHTestBench();
    await bench.start();
    echo = new EchoServer('life:');
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
  });

  function makeTunnel(overrides = {}) {
    return new SSHTunnel({
      transport: {
        endpoint: { host: '127.0.0.1', port: bench.port },
        username: 'tester',
        privateKey: credential.inline(bench.clientKey.private),
      },
      ...overrides,
    });
  }

  it('degrades forwards, reconnects with backoff, and restores both directions', async function () {
    const listenPort = await freePort();

    tunnel = makeTunnel({
      reconnect: { enabled: true, initialDelayMs: 100, maxDelayMs: 400, maxAttempts: 5 },
      localForwards: [
        {
          id: 'echo-local',
          listen: { host: '127.0.0.1', port: listenPort },
          target: { host: '127.0.0.1', port: echo.port },
        },
      ],
      remoteForwards: [
        {
          id: 'echo-remote',
          bind: { host: '127.0.0.1', port: 0 },
          target: { host: '127.0.0.1', port: echo.port },
        },
      ],
    });

    const forwardStates = [];
    tunnel.on('forward', (event) => forwardStates.push([event.status.forwardId, event.status.state]));

    await tunnel.connect();
    assert.equal(await roundTrip(listenPort, 'before'), 'life:before');
    const firstRemotePort = tunnel.resolveEndpoint('echo-remote').endpoint.port;
    assert.equal(await roundTrip(firstRemotePort, 'before-r'), 'life:before-r');

    const reconnectEvent = waitFor(tunnel, 'reconnect');
    const readyAgain = waitFor(tunnel, 'ready');

    bench.dropConnections();

    const scheduled = await reconnectEvent;
    assert.equal(scheduled.attempt, 1);
    assert.ok(scheduled.delayMs >= 50 && scheduled.delayMs <= 400);
    assert.equal(tunnel.getState(), 'reconnecting');

    // While the transport is down the listener stays bound but is degraded.
    assert.equal(tunnel.getForwardStatus('echo-local').state, 'degraded');

    await readyAgain;
    assert.equal(tunnel.getState(), 'ready');
    assert.equal(tunnel.getStatus().reconnectAttempt, 0, 'attempt counter resets on success');

    assert.equal(await roundTrip(listenPort, 'after'), 'life:after');
    assert.equal(tunnel.getForwardStatus('echo-local').state, 'active');

    const secondRemotePort = tunnel.resolveEndpoint('echo-remote').endpoint.port;
    assert.equal(tunnel.getForwardStatus('echo-remote').state, 'active');
    assert.equal(await roundTrip(secondRemotePort, 'after-r'), 'life:after-r');

    assert.ok(
      forwardStates.some(([id, state]) => id === 'echo-local' && state === 'degraded'),
      'the local forward should be reported degraded',
    );
    assert.ok(
      forwardStates.filter(([id, state]) => id === 'echo-local' && state === 'active').length >= 2,
      'the local forward should return to active after reconnect',
    );
  });

  it('reports failed and stops trying when reconnection is disabled', async function () {
    tunnel = makeTunnel({ reconnect: { enabled: false } });
    await tunnel.connect();

    const failed = waitFor(tunnel, 'state', (event) => event.current === 'failed');
    bench.dropConnections();
    await failed;

    assert.equal(tunnel.getState(), 'failed');
  });

  it('gives up with RECONNECT_EXHAUSTED once maxAttempts is spent', async function () {
    const deadPort = await freePort();
    tunnel = new SSHTunnel({
      transport: {
        endpoint: { host: '127.0.0.1', port: deadPort },
        username: 'tester',
        privateKey: credential.inline(bench.clientKey.private),
      },
      reconnect: { enabled: true, initialDelayMs: 50, maxDelayMs: 100, maxAttempts: 2 },
    });

    const exhausted = waitFor(tunnel, 'error', (err) => err.code === 'RECONNECT_EXHAUSTED');
    await tunnel.connect();
    const err = await exhausted;

    assert.match(err.message, /Giving up after/);
    assert.equal(tunnel.getState(), 'failed');
  });

  it('surfaces AUTH_FAILED without retrying forever', async function () {
    const otherKey = new SSHTestBench().clientKey;
    tunnel = new SSHTunnel({
      transport: {
        endpoint: { host: '127.0.0.1', port: bench.port },
        username: 'tester',
        privateKey: credential.inline(otherKey.private),
      },
      reconnect: { enabled: false },
    });

    await assert.rejects(() => tunnel.connect(), (err) => err.code === 'AUTH_FAILED');
    assert.equal(tunnel.getState(), 'failed');
  });

  it('fails fast with CREDENTIAL_UNRESOLVED when no auth material is supplied', async function () {
    tunnel = new SSHTunnel({
      transport: {
        endpoint: { host: '127.0.0.1', port: bench.port },
        username: 'tester',
      },
      reconnect: { enabled: false },
    });

    await assert.rejects(() => tunnel.connect(), (err) => err.code === 'CREDENTIAL_UNRESOLVED');
  });

  it('rejects a connection attempt when the host key does not match', async function () {
    tunnel = new SSHTunnel({
      transport: {
        endpoint: { host: '127.0.0.1', port: bench.port },
        username: 'tester',
        privateKey: credential.inline(bench.clientKey.private),
        hostKeyFingerprints: ['sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
      },
      reconnect: { enabled: false },
    });

    await assert.rejects(() => tunnel.connect());
    assert.equal(tunnel.getState(), 'failed');
  });

  it('shares one attempt between concurrent connect() calls', async function () {
    tunnel = makeTunnel({ reconnect: { enabled: false } });
    const [a, b, c] = await Promise.all([tunnel.connect(), tunnel.connect(), tunnel.connect()]);
    assert.equal(a.state, 'ready');
    assert.equal(b.state, 'ready');
    assert.equal(c.state, 'ready');
  });

  it('is idempotent on close', async function () {
    tunnel = makeTunnel({ reconnect: { enabled: false } });
    await tunnel.connect();
    await tunnel.close();
    await tunnel.close();
    assert.equal(tunnel.getState(), 'closed');
    tunnel = undefined;
  });

  it('refuses to open a forward while the transport is not ready', async function () {
    tunnel = makeTunnel({ reconnect: { enabled: false } });
    await assert.rejects(
      () =>
        tunnel.addRemoteForward({
          id: 'too-early',
          bind: { host: '127.0.0.1', port: 0 },
          target: { host: '127.0.0.1', port: echo.port },
        }),
      (err) => err.code === 'TRANSPORT_NOT_READY',
    );
  });
});
