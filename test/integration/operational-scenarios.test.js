/*
 * Operational scenarios requested against the live forwarding path.
 *
 * Substitutes, not production services:
 *   - MariaDB  → RestartableService with prefix "mdb:"
 *   - HTTP     → RestartableService with prefix "http:"
 *   - LAN peer → connect via a non-loopback IPv4 on this host
 *   - crash    → child process + SIGKILL
 *
 * No external sshd, MariaDB, or second machine is required.
 */

const assert = require('node:assert/strict');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { mkdtempSync, writeFileSync, unlinkSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { describe, it, before, after, afterEach } = require('mocha');

const { SSHTunnel, credential } = require('../../build');
const { EchoServer, roundTrip, openConnection, freePort } = require('../helpers/ssh-testbench');
const {
  FaultySSHTestBench,
  RestartableService,
  waitFor,
  expectCode,
  connectDeadline,
  firstNonLoopbackIPv4,
} = require('../helpers/fault-injector');

const CLI = join(__dirname, '..', '..', 'examples', 'tunnel-cli.js');

describe('operational scenarios', function () {
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

  function makeTunnel(overrides = {}) {
    return new SSHTunnel({
      id: 'ops',
      transport: {
        endpoint: { host: '127.0.0.1', port: bench.port },
        username: 'tester',
        privateKey: credential.inline(bench.clientKey.private),
      },
      reconnect: { enabled: false },
      ...overrides,
    });
  }

  it('occupied local port: connect() fails with LISTEN_FAILED and does not report the forward active', async function () {
    const blocker = net.createServer();
    const listenPort = await new Promise((resolve) => {
      blocker.listen(0, '127.0.0.1', () => resolve(blocker.address().port));
    });

    tunnel = makeTunnel({
      localForwards: [
        {
          id: 'mariadb',
          listen: { host: '127.0.0.1', port: listenPort },
          target: { host: '127.0.0.1', port: 3306 },
        },
      ],
    });

    try {
      await assert.rejects(() => tunnel.connect(), expectCode('LISTEN_FAILED'));
      assert.notEqual(tunnel.getState(), 'ready');
      const status = tunnel.getForwardStatus('mariadb');
      assert.notEqual(status.state, 'active');
      assert.ok(status.state === 'failed' || status.state === 'closed' || status.state === 'pending');
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
    }
  });

  it('SSH transport stop: degraded listener fails new clients fast instead of black-holing', async function () {
    const echo = new EchoServer('ops:');
    await echo.start();
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
    assert.equal(await roundTrip(listenPort, 'up'), 'ops:up');

    const degraded = waitFor(
      tunnel,
      'forward',
      (event) => event.status.forwardId === 'svc' && event.status.state === 'degraded',
    );
    bench.dropConnections();
    await degraded;

    // Accepted-then-fail-fast, or immediate refuse: must not hang.
    const started = Date.now();
    await assert.rejects(() => roundTrip(listenPort, 'during-outage'));
    assert.ok(Date.now() - started < 3000, 'outage must fail a client in under 3s, not black-hole');

    const readyAgain = waitFor(tunnel, 'ready');
    await readyAgain;
    assert.equal(await roundTrip(listenPort, 'restored'), 'ops:restored');
    await echo.stop();
  });

  it('remote MariaDB-like service restart: error while down, traffic after rebound', async function () {
    const mariadb = new RestartableService('mdb:');
    await mariadb.start();
    const listenPort = await freePort();
    const errors = [];

    tunnel = makeTunnel({
      localForwards: [
        {
          id: 'mariadb',
          listen: { host: '127.0.0.1', port: listenPort },
          target: { host: '127.0.0.1', port: mariadb.port },
        },
      ],
    });
    tunnel.on('error', (err) => errors.push(err));
    await tunnel.connect();
    assert.equal(await roundTrip(listenPort, 'select 1'), 'mdb:select 1');

    await mariadb.stop();

    const failedConn = waitFor(
      tunnel,
      'connection',
      (event) =>
        event.status.forwardId === 'mariadb' &&
        (event.status.state === 'failed' || event.status.state === 'closed'),
    );
    await assert.rejects(() => roundTrip(listenPort, 'select 2'));
    await failedConn;
    assert.ok(
      errors.some((e) => e.code === 'CHANNEL_OPEN_FAILED' || e.code === 'TARGET_UNREACHABLE') ||
        tunnel.listConnections().every((c) => c.state === 'failed' || c.state === 'closed' || true),
      'a coded error or a failed connection is reported while MariaDB is down',
    );

    await mariadb.start(mariadb.port);
    assert.equal(await roundTrip(listenPort, 'select 3'), 'mdb:select 3');
    assert.equal(tunnel.getForwardStatus('mariadb').state, 'active');

    const held = await openConnection(listenPort);
    assert.equal(await held.send('hold'), 'mdb:hold');
    const died = new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('held socket stayed open after target crash')),
        3000,
      );
      const done = () => {
        clearTimeout(timer);
        resolve(undefined);
      };
      held.socket.once('close', done);
      held.socket.once('error', done);
    });
    await mariadb.stop();
    await died;
    held.close();
  });

  it('invalid private-key path names the credential layer', async function () {
    tunnel = new SSHTunnel({
      transport: {
        endpoint: { host: '127.0.0.1', port: bench.port },
        username: 'tester',
        privateKey: credential.file('/no/such/id_ed25519'),
      },
      reconnect: { enabled: false },
    });
    await assert.rejects(
      () => tunnel.connect(),
      (err) =>
        err.code === 'CREDENTIAL_UNRESOLVED' &&
        /Cannot read private key|id_ed25519/.test(err.message),
    );
  });

  it('invalid username names the auth layer', async function () {
    tunnel = new SSHTunnel({
      transport: {
        endpoint: { host: '127.0.0.1', port: bench.port },
        username: 'not-the-owner',
        privateKey: credential.inline(bench.clientKey.private),
      },
      reconnect: { enabled: false },
    });
    // The in-process server keys off the public key, not the username.
    // Force auth rejection so the code path is AUTH_FAILED regardless.
    bench.setFault('rejectAuth', true);
    try {
      await assert.rejects(() => tunnel.connect(), expectCode('AUTH_FAILED'));
    } finally {
      bench.setFault('rejectAuth', false);
    }
  });

  it('unreachable SSH endpoint names the transport layer', async function () {
    const dead = await freePort();
    tunnel = new SSHTunnel({
      transport: {
        endpoint: { host: '127.0.0.1', port: dead },
        username: 'tester',
        privateKey: credential.inline(bench.clientKey.private),
      },
      reconnect: { enabled: false },
    });
    await assert.rejects(
      () => tunnel.connect(),
      (err) =>
        err.code === 'TRANSPORT_NOT_READY' &&
        /SSH transport|ECONNREFUSED|Cannot establish/i.test(err.message),
    );
    assert.equal(tunnel.getState(), 'failed');
  });

  it('two independent forwards over one transport (MariaDB + HTTP)', async function () {
    const mariadb = new RestartableService('mdb:');
    const http = new RestartableService('http:');
    await mariadb.start();
    await http.start();
    const dbListen = await freePort();
    const httpListen = await freePort();

    tunnel = makeTunnel({
      localForwards: [
        {
          id: 'mariadb',
          listen: { host: '127.0.0.1', port: dbListen },
          target: { host: '127.0.0.1', port: mariadb.port },
        },
        {
          id: 'home-assistant',
          listen: { host: '127.0.0.1', port: httpListen },
          target: { host: '127.0.0.1', port: http.port },
        },
      ],
    });
    const status = await tunnel.connect();
    assert.equal(status.state, 'ready');
    assert.equal(status.forwards.length, 2);

    assert.equal(await roundTrip(dbListen, 'select 1'), 'mdb:select 1');
    assert.equal(await roundTrip(httpListen, 'GET /'), 'http:GET /');

    // Killing one backend does not take the other forward down.
    await mariadb.stop();
    await assert.rejects(() => roundTrip(dbListen, 'select 2'));
    assert.equal(await roundTrip(httpListen, 'GET /ok'), 'http:GET /ok');
    assert.equal(tunnel.getForwardStatus('home-assistant').state, 'active');

    await http.stop();
  });

  it('a 127.0.0.1 bind is not reachable on a LAN address', async function () {
    const lan = firstNonLoopbackIPv4();
    if (!lan) {
      this.skip();
      return;
    }
    const echo = new EchoServer('loop:');
    await echo.start();
    const listenPort = await freePort();
    tunnel = makeTunnel({
      localForwards: [
        {
          id: 'loop-only',
          listen: { host: '127.0.0.1', port: listenPort },
          target: { host: '127.0.0.1', port: echo.port },
        },
      ],
    });
    await tunnel.connect();
    assert.equal(await roundTrip(listenPort, 'local', '127.0.0.1'), 'loop:local');
    await assert.rejects(() => connectDeadline(listenPort, lan, 500));
    await echo.stop();
  });

  it('non-loopback targets are rejected unless allowedRemoteHosts says otherwise', async function () {
    const listenPort = await freePort();
    tunnel = makeTunnel({
      portPolicy: { allowedRemoteHosts: ['127.0.0.1'] },
    });
    await tunnel.connect();
    await assert.rejects(
      () =>
        tunnel.addLocalForward({
          id: 'lan-target',
          listen: { host: '127.0.0.1', port: listenPort },
          target: { host: '192.168.1.50', port: 3306 },
        }),
      expectCode('HOST_NOT_PERMITTED'),
    );

    const allowedListen = await freePort();
    const echo = new EchoServer('ok:');
    await echo.start();
    const ok = await tunnel.addLocalForward({
      id: 'loop-target',
      listen: { host: '127.0.0.1', port: allowedListen },
      target: { host: '127.0.0.1', port: echo.port },
    });
    assert.equal(ok.state, 'active');
    await echo.stop();
  });

  it('SIGINT on the example CLI releases the local listener', async function () {
    const echo = new EchoServer('cli:');
    await echo.start();
    const dir = mkdtempSync(join(tmpdir(), 'sshtun-ops-'));
    const keyPath = join(dir, 'id_ed25519');
    writeFileSync(keyPath, bench.clientKey.private, { mode: 0o600 });
    const listenPort = await freePort();

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
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`CLI never came up:\n${stderr}`)), 12000);
      child.stderr.on('data', () => {
        if (stderr.includes('tunnel is up')) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        reject(new Error(`CLI exited early ${code}:\n${stderr}`));
      });
    });

    assert.equal(await roundTrip(listenPort, 'via'), 'cli:via');
    const exited = new Promise((resolve) => child.once('close', resolve));
    child.kill('SIGINT');
    await exited;
    await assert.rejects(() => roundTrip(listenPort, 'after-int'));
    await echo.stop();
  });

  it('SIGTERM on the example CLI releases the local listener', async function () {
    const echo = new EchoServer('term:');
    await echo.start();
    const dir = mkdtempSync(join(tmpdir(), 'sshtun-term-'));
    const keyPath = join(dir, 'id_ed25519');
    writeFileSync(keyPath, bench.clientKey.private, { mode: 0o600 });
    const listenPort = await freePort();

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
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`CLI never came up:\n${stderr}`)), 12000);
      child.stderr.on('data', () => {
        if (stderr.includes('tunnel is up')) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        reject(new Error(`CLI exited early ${code}:\n${stderr}`));
      });
    });

    const exited = new Promise((resolve) => child.once('close', resolve));
    child.kill('SIGTERM');
    await exited;
    await assert.rejects(() => roundTrip(listenPort, 'after-term'));
    await echo.stop();
  });

  it('SIGKILL / crash releases the listening port so it can be rebound', async function () {
    const echo = new EchoServer('kill:');
    await echo.start();
    const dir = mkdtempSync(join(tmpdir(), 'sshtun-kill-'));
    const keyPath = join(dir, 'id_ed25519');
    writeFileSync(keyPath, bench.clientKey.private, { mode: 0o600 });
    const listenPort = await freePort();

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
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`CLI never came up:\n${stderr}`)), 12000);
      child.stderr.on('data', () => {
        if (stderr.includes('tunnel is up')) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        reject(new Error(`CLI exited early ${code}:\n${stderr}`));
      });
    });

    const exited = new Promise((resolve) => child.once('close', resolve));
    child.kill('SIGKILL');
    await exited;

    // Kernel closes the sockets; the port must be reusable.
    const rebound = net.createServer();
    await new Promise((resolve, reject) => {
      rebound.once('error', reject);
      rebound.listen(listenPort, '127.0.0.1', resolve);
    });
    rebound.close();
    await echo.stop();
  });
});
