/*
 * Local forwarding (ssh -L) against an in-process SSH server.
 *
 * Topology under test, which mirrors the verified workstation -> zrok -> Termux
 * path with the relay removed:
 *
 *   client 127.0.0.1:<listen>  ->  SSH transport  ->  echo server 127.0.0.1:<echo>
 */

const assert = require('node:assert/strict');
const { describe, it, before, after } = require('mocha');

const { SSHTunnel, credential } = require('../../build');
const {
  SSHTestBench,
  EchoServer,
  roundTrip,
  openConnection,
  freePort,
} = require('../helpers/ssh-testbench');

describe('local forwarding', function () {
  let bench;
  let echo;
  let tunnel;

  before(async function () {
    bench = new SSHTestBench();
    await bench.start();
    echo = new EchoServer('echo:');
    await echo.start();
  });

  after(async function () {
    if (tunnel) await tunnel.close();
    await echo.stop();
    await bench.stop();
  });

  function makeTunnel(overrides = {}) {
    return new SSHTunnel({
      id: 'testbench',
      transport: {
        endpoint: { host: '127.0.0.1', port: bench.port },
        username: 'tester',
        privateKey: credential.inline(bench.clientKey.private),
      },
      reconnect: { enabled: false },
      ...overrides,
    });
  }

  it('connects and reports ready with no forwards declared', async function () {
    tunnel = makeTunnel();
    const states = [];
    tunnel.on('state', (event) => states.push(event.current));

    const status = await tunnel.connect();

    assert.equal(status.state, 'ready');
    assert.equal(tunnel.isReady(), true);
    assert.deepEqual(states, ['connecting', 'ready']);
    assert.ok(status.connectedAtUnixMs > 0);
  });

  it('opens a forward declared with the structured API', async function () {
    const listenPort = await freePort();
    const status = await tunnel.addLocalForward({
      id: 'echo-service',
      listen: { host: '127.0.0.1', port: listenPort },
      target: { host: '127.0.0.1', port: echo.port },
    });

    assert.equal(status.forwardId, 'echo-service');
    assert.equal(status.direction, 'local');
    assert.equal(status.state, 'active');
    assert.equal(status.activeConnections, 0);
  });

  it('carries data end to end through the forward', async function () {
    const { endpoint } = tunnel.resolveEndpoint('echo-service');
    const response = await roundTrip(endpoint.port, 'hello');
    assert.equal(response, 'echo:hello');
  });

  it('resolves a semantic forward id to a loopback endpoint', function () {
    const resolved = tunnel.resolveEndpoint('echo-service');
    assert.equal(resolved.state, 'active');
    assert.equal(resolved.endpoint.host, '127.0.0.1');
    assert.ok(resolved.endpoint.port > 0);
    assert.throws(() => tunnel.resolveEndpoint('nope'), /No forward with id/);
  });

  it('multiplexes several simultaneous connections over one transport', async function () {
    const { endpoint } = tunnel.resolveEndpoint('echo-service');
    const connections = await Promise.all([
      openConnection(endpoint.port),
      openConnection(endpoint.port),
      openConnection(endpoint.port),
      openConnection(endpoint.port),
    ]);

    // Interleave writes so a shared-socket implementation would cross the wires.
    const replies = await Promise.all(
      connections.map((connection, index) => connection.send(`msg-${index}`)),
    );

    replies.forEach((reply, index) => {
      assert.equal(reply, `echo:msg-${index}`, 'each connection must get its own reply');
    });

    const live = tunnel.listConnections();
    assert.equal(live.length, 4);
    assert.ok(live.every((connection) => connection.state === 'piped'));
    assert.ok(live.every((connection) => connection.bytesToTarget > 0));
    assert.equal(new Set(live.map((c) => c.connectionId)).size, 4);

    for (const connection of connections) connection.close();
    await new Promise((resolve) => setTimeout(resolve, 200));

    const status = tunnel.getForwardStatus('echo-service');
    assert.equal(status.activeConnections, 0, 'closed connections must be reaped');
    assert.ok(status.totalConnections >= 5);
  });

  it('emits connection state transitions with byte counts', async function () {
    const seen = [];
    const listener = (event) => seen.push(event.status.state);
    tunnel.on('connection', listener);

    const { endpoint } = tunnel.resolveEndpoint('echo-service');
    await roundTrip(endpoint.port, 'traced');
    await new Promise((resolve) => setTimeout(resolve, 200));
    tunnel.off('connection', listener);

    assert.ok(seen.includes('opening'));
    assert.ok(seen.includes('piped'));
    assert.ok(seen.includes('closed') || seen.includes('failed'));
  });

  it('accepts the v1 spec string syntax', async function () {
    const listenPort = await freePort();
    const status = await tunnel.addLocalForward(`${listenPort}:127.0.0.1:${echo.port}`);
    assert.equal(status.forwardId, `${listenPort}:127.0.0.1:${echo.port}`);
    assert.equal(await roundTrip(listenPort, 'legacy'), 'echo:legacy');
    await tunnel.removeForward(status.forwardId);
  });

  it('opens several forwards atomically and rolls back a partial failure', async function () {
    const good = await freePort();
    const blocker = await openConnection(tunnel.resolveEndpoint('echo-service').endpoint.port);
    const taken = tunnel.resolveEndpoint('echo-service').endpoint.port;
    blocker.close();

    await assert.rejects(
      () =>
        tunnel.addLocalForwards([
          { id: 'rollback-a', listen: { host: '127.0.0.1', port: good }, target: { host: '127.0.0.1', port: echo.port } },
          { id: 'rollback-b', listen: { host: '127.0.0.1', port: taken }, target: { host: '127.0.0.1', port: echo.port } },
        ]),
      (err) => err.code === 'LISTEN_FAILED',
    );

    assert.throws(() => tunnel.getForwardStatus('rollback-a'), /No forward with id/);
    assert.throws(() => tunnel.getForwardStatus('rollback-b'), /No forward with id/);
  });

  it('enforces maxConnections per forward', async function () {
    const listenPort = await freePort();
    await tunnel.addLocalForward({
      id: 'limited',
      listen: { host: '127.0.0.1', port: listenPort },
      target: { host: '127.0.0.1', port: echo.port },
      maxConnections: 1,
    });

    const errors = [];
    const listener = (err) => errors.push(err.code);
    tunnel.on('error', listener);

    const first = await openConnection(listenPort);
    assert.equal(await first.send('one'), 'echo:one');

    await assert.rejects(async () => {
      const second = await openConnection(listenPort);
      await second.send('two');
    });

    tunnel.off('error', listener);
    first.close();
    assert.ok(errors.includes('CONNECTION_LIMIT'));
    await tunnel.removeForward('limited');
  });

  it('rejects a forward that violates the port policy before touching the network', async function () {
    const restricted = new SSHTunnel({
      transport: {
        endpoint: { host: '127.0.0.1', port: bench.port },
        username: 'tester',
        privateKey: credential.inline(bench.clientKey.private),
      },
      portPolicy: { allowedRemoteTargetPorts: [8080] },
    });

    const listenPort = await freePort();
    await assert.rejects(
      () => restricted.addLocalForward(`${listenPort}:127.0.0.1:9999`),
      (err) => err.code === 'PORT_NOT_PERMITTED',
    );
    await restricted.close();
  });

  it('fails a connection with TRANSPORT_NOT_READY when the peer refuses the channel', async function () {
    const listenPort = await freePort();
    await tunnel.addLocalForward({
      id: 'refused',
      listen: { host: '127.0.0.1', port: listenPort },
      target: { host: '127.0.0.1', port: echo.port },
    });

    const errors = [];
    const listener = (err) => errors.push(err.code);
    tunnel.on('error', listener);

    bench.rejectDirectTcpip = true;
    await assert.rejects(() => roundTrip(listenPort, 'nope'));
    bench.rejectDirectTcpip = false;
    tunnel.off('error', listener);

    assert.ok(errors.includes('CHANNEL_OPEN_FAILED'));
    // The listener survives a rejected channel.
    assert.equal(tunnel.getForwardStatus('refused').state, 'active');
    assert.equal(await roundTrip(listenPort, 'recovered'), 'echo:recovered');
    await tunnel.removeForward('refused');
  });

  it('runs a single command over the transport', async function () {
    const result = await tunnel.exec('uname -a');
    assert.equal(result.code, 0);
    assert.match(result.stdout, /ran:uname -a/);
  });

  it('releases the listener on removeForward', async function () {
    const listenPort = await freePort();
    await tunnel.addLocalForward({
      id: 'temporary',
      listen: { host: '127.0.0.1', port: listenPort },
      target: { host: '127.0.0.1', port: echo.port },
    });
    assert.equal(await roundTrip(listenPort, 'here'), 'echo:here');

    const status = await tunnel.removeForward('temporary');
    assert.equal(status.state, 'closed');
    await assert.rejects(() => roundTrip(listenPort, 'gone'));
  });

  it('closes cleanly and reports closed state', async function () {
    const status = await tunnel.close();
    assert.equal(status.state, 'closed');
    assert.equal(tunnel.isReady(), false);
    assert.ok(status.forwards.every((forward) => forward.state === 'closed'));
    tunnel = undefined;
  });
});
