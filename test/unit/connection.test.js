const assert = require('node:assert/strict');
const { Duplex } = require('node:stream');
const { describe, it } = require('mocha');

const { ProxiedConnection } = require('../../build');

/*
 * A duplex whose write side is a sink and whose read side is fed manually.
 * Two of these can be cross-piped without the feedback loop you would get from
 * cross-piping two PassThroughs.
 */
function stubStream(name) {
  const written = [];
  const stream = new Duplex({
    write(chunk, _encoding, callback) {
      written.push(chunk.toString());
      callback();
    },
    read() {},
  });
  stream.name = name;
  stream.written = written;
  return stream;
}

function makeConnection(overrides = {}) {
  const transitions = [];
  const connection = new ProxiedConnection({
    forwardId: 'demo',
    direction: 'local',
    source: { host: '127.0.0.1', port: 40001 },
    destination: { host: '127.0.0.1', port: 8080 },
    onStateChange: (status, previous) => transitions.push([previous, status.state]),
    ...overrides,
  });
  return { connection, transitions };
}

describe('ProxiedConnection', function () {
  it('starts in accepted state with a generated id', function () {
    const { connection } = makeConnection();
    assert.equal(connection.getState(), 'accepted');
    assert.match(connection.connectionId, /^[0-9a-f-]{36}$/);
    assert.equal(connection.isClosed(), false);
  });

  it('reports opening then piped and counts bytes in both directions', async function () {
    const { connection, transitions } = makeConnection();
    const inbound = stubStream('inbound');
    const outbound = stubStream('outbound');

    connection.markOpening();
    connection.attach(inbound, outbound);

    assert.equal(connection.getState(), 'piped');
    assert.deepEqual(transitions, [
      ['accepted', 'opening'],
      ['opening', 'piped'],
    ]);

    inbound.push('hello');
    outbound.push('worldly');
    await new Promise((resolve) => setTimeout(resolve, 20));

    const status = connection.getStatus();
    assert.equal(status.bytesToTarget, 5);
    assert.equal(status.bytesFromTarget, 7);
    assert.deepEqual(outbound.written, ['hello'], 'inbound bytes reach the outbound side');
    assert.deepEqual(inbound.written, ['worldly'], 'outbound bytes reach the inbound side');
    assert.equal(status.forwardId, 'demo');
    assert.equal(status.direction, 'local');
  });

  it('is idempotent on close and destroys both halves exactly once', function () {
    const { connection, transitions } = makeConnection();
    const inbound = stubStream('inbound');
    const outbound = stubStream('outbound');
    connection.attach(inbound, outbound);

    connection.close();
    connection.close();
    connection.close();

    assert.equal(connection.getState(), 'closed');
    assert.equal(inbound.destroyed, true);
    assert.equal(outbound.destroyed, true);
    assert.equal(transitions.filter(([, next]) => next === 'closed').length, 1);
    assert.ok(connection.getStatus().closedAtUnixMs >= connection.openedAtUnixMs);
  });

  it('records a failure with the side that failed and does not later reopen', function () {
    const { connection } = makeConnection();
    connection.attach(stubStream('inbound'), stubStream('outbound'));

    connection.fail(new Error('boom'), 'outbound');
    assert.equal(connection.getState(), 'failed');
    assert.equal(connection.getStatus().error, 'outbound: boom');

    connection.close();
    assert.equal(connection.getState(), 'failed', 'terminal state must not be overwritten');
  });

  it('does not leak streams when the socket closed before the channel opened', function () {
    const { connection } = makeConnection();
    connection.markOpening();
    connection.close();

    const inbound = stubStream('inbound');
    const outbound = stubStream('outbound');
    connection.attach(inbound, outbound);

    assert.equal(inbound.destroyed, true);
    assert.equal(outbound.destroyed, true);
    assert.equal(connection.getState(), 'closed');
  });

  it('propagates a half close to the other side rather than destroying it', async function () {
    const { connection } = makeConnection();
    const inbound = stubStream('inbound');
    const outbound = stubStream('outbound');
    connection.attach(inbound, outbound);

    inbound.push(null);
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.ok(['half_closed', 'closed'].includes(connection.getState()));
  });
});
