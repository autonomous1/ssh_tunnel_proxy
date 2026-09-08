/*
 * Reverse forwarding (ssh -R) against an in-process SSH server.
 *
 * Topology under test, which is the constrained-device case: the device dials out,
 * the peer listens, and connections to the peer's port land on a service the
 * device can reach.
 *
 *   peer 127.0.0.1:<bound>  ->  SSH transport  ->  echo server 127.0.0.1:<echo>
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

describe('reverse forwarding', function () {
  let bench;
  let echo;
  let tunnel;

  before(async function () {
    bench = new SSHTestBench();
    await bench.start();
    echo = new EchoServer('rev:');
    await echo.start();

    tunnel = new SSHTunnel({
      id: 'reverse-testbench',
      transport: {
        endpoint: { host: '127.0.0.1', port: bench.port },
        username: 'tester',
        privateKey: credential.inline(bench.clientKey.private),
      },
      reconnect: { enabled: false },
    });
    await tunnel.connect();
  });

  after(async function () {
    if (tunnel) await tunnel.close();
    await echo.stop();
    await bench.stop();
  });

  it('asks the peer to bind a listener and reports the assigned port', async function () {
    const status = await tunnel.addRemoteForward({
      id: 'exposed-echo',
      bind: { host: '127.0.0.1', port: 0 },
      target: { host: '127.0.0.1', port: echo.port },
    });

    assert.equal(status.direction, 'remote');
    assert.equal(status.state, 'active');
    assert.ok(status.assignedPort > 0, 'a peer-assigned port must be reported');
    assert.equal(status.listen.port, status.assignedPort);
  });

  it('delivers a connection made on the peer to the local target', async function () {
    const { endpoint } = tunnel.resolveEndpoint('exposed-echo');
    assert.equal(await roundTrip(endpoint.port, 'ping'), 'rev:ping');
  });

  it('gives every inbound channel its own outbound socket', async function () {
    const { endpoint } = tunnel.resolveEndpoint('exposed-echo');
    const before = echo.connectionCount;

    const connections = await Promise.all([
      openConnection(endpoint.port),
      openConnection(endpoint.port),
      openConnection(endpoint.port),
    ]);

    const replies = await Promise.all(
      connections.map((connection, index) => connection.send(`r-${index}`)),
    );

    replies.forEach((reply, index) => {
      assert.equal(reply, `rev:r-${index}`, 'replies must not be interleaved across connections');
    });

    assert.equal(
      echo.connectionCount - before,
      3,
      'one fresh target socket per channel; v1 reused a single socket',
    );

    const live = tunnel.listConnections().filter((c) => c.forwardId === 'exposed-echo');
    assert.equal(live.length, 3);
    assert.equal(new Set(live.map((c) => c.connectionId)).size, 3);
    assert.ok(live.every((c) => c.direction === 'remote'));

    for (const connection of connections) connection.close();
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(tunnel.getForwardStatus('exposed-echo').activeConnections, 0);
  });

  it('reports TARGET_UNREACHABLE when the local service is down', async function () {
    const deadPort = await freePort();
    await tunnel.addRemoteForward({
      id: 'dead-target',
      bind: { host: '127.0.0.1', port: 0 },
      target: { host: '127.0.0.1', port: deadPort },
    });

    const errors = [];
    const listener = (err) => errors.push(err.code);
    tunnel.on('error', listener);

    const { endpoint } = tunnel.resolveEndpoint('dead-target');
    await assert.rejects(() => roundTrip(endpoint.port, 'anyone'));
    await new Promise((resolve) => setTimeout(resolve, 200));
    tunnel.off('error', listener);

    assert.ok(errors.includes('TARGET_UNREACHABLE'));
    // The registration survives an unreachable target.
    assert.equal(tunnel.getForwardStatus('dead-target').state, 'active');
    await tunnel.removeForward('dead-target');
  });

  it('accepts the v1 spec string syntax for reverse forwards', async function () {
    const status = await tunnel.addRemoteForward(`0:127.0.0.1:${echo.port}`);
    assert.equal(status.state, 'active');
    const { endpoint } = tunnel.resolveEndpoint(status.forwardId);
    assert.equal(await roundTrip(endpoint.port, 'spec'), 'rev:spec');
    await tunnel.removeForward(status.forwardId);
  });

  it('unbinds on the peer when the forward is removed', async function () {
    const status = await tunnel.addRemoteForward({
      id: 'temporary-reverse',
      bind: { host: '127.0.0.1', port: 0 },
      target: { host: '127.0.0.1', port: echo.port },
    });
    const port = status.assignedPort;
    assert.equal(await roundTrip(port, 'still-here'), 'rev:still-here');

    await tunnel.removeForward('temporary-reverse');
    await new Promise((resolve) => setTimeout(resolve, 200));
    await assert.rejects(() => roundTrip(port, 'gone'));
  });

  it('reports both directions in one tunnel status', async function () {
    const listenPort = await freePort();
    await tunnel.addLocalForward({
      id: 'both-ways',
      listen: { host: '127.0.0.1', port: listenPort },
      target: { host: '127.0.0.1', port: echo.port },
    });

    const status = tunnel.getStatus();
    const directions = new Set(status.forwards.map((forward) => forward.direction));
    assert.deepEqual([...directions].sort(), ['local', 'remote']);
    assert.equal(await roundTrip(listenPort, 'L'), 'rev:L');
    assert.equal(
      await roundTrip(tunnel.resolveEndpoint('exposed-echo').endpoint.port, 'R'),
      'rev:R',
    );
  });
});
