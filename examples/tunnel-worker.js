'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const { SSHTunnel, isTunnelError } = require('../build');

const { config, label, verbose, debugSsh } = workerData;

function send(message) {
  parentPort.postMessage(message);
}

function describeForward(forward) {
  const arrow = forward.direction === 'local' ? '->' : '<-';
  const port = forward.assignedPort ?? forward.listen.port;
  return (
    `  ${forward.direction === 'local' ? 'L' : 'R'} ${forward.listen.host}:${port} ` +
    `${arrow} ${forward.target.host}:${forward.target.port}  [${forward.state}]`
  );
}

const tunnel = new SSHTunnel(config, { debugSsh: Boolean(debugSsh) });

if (verbose) {
  tunnel.on('debug', (message, ...args) => {
    send({ type: 'log', line: `debug[${label}]: ${message} ${args.map(String).join(' ')}`.trim() });
  });
  tunnel.on('forward', ({ status, previous }) => {
    send({
      type: 'log',
      line: `forward[${label}] ${status.forwardId}: ${previous} -> ${status.state}`,
    });
  });
}

tunnel.on('reconnect', ({ attempt, delayMs, cause }) => {
  send({
    type: 'log',
    line: `link lost [${label}] (${cause ?? 'unknown'}); retry ${attempt} in ${delayMs}ms`,
  });
});

tunnel.on('error', (err) => {
  send({ type: 'log', line: `[${label} ${err.code ?? 'ERROR'}] ${err.message}` });
});

tunnel.on('ready', (status) => {
  for (const forward of status.forwards) send({ type: 'log', line: describeForward(forward) });
});

tunnel.on('state', ({ current }) => {
  send({ type: 'state', current });
});

parentPort.on('message', async (message) => {
  if (message?.op === 'close') {
    await tunnel.close().catch(() => {});
    process.exit(0);
  }
  if (message?.op === 'exec') {
    try {
      const result = await tunnel.exec(message.command);
      send({ type: 'exec-result', ...result });
    } catch (err) {
      send({
        type: 'exec-result',
        code: 1,
        stdout: '',
        stderr: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (message?.op === 'status') {
    send({
      type: 'status',
      state: tunnel.getState(),
      connections: tunnel.listConnections(),
    });
  }
});

tunnel
  .connect()
  .then((status) => {
    send({
      type: 'ready',
      username: config.transport.username,
      host: status.endpoint.host,
      port: status.endpoint.port,
    });
  })
  .catch((err) => {
    if (isTunnelError(err)) {
      send({ type: 'failed', code: err.code, message: err.message });
    } else {
      send({ type: 'failed', code: 'TRANSPORT_NOT_READY', message: String(err) });
    }
    setTimeout(() => process.exit(1), 20);
  });
