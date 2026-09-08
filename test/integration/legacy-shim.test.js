/*
 * The v1-compatible shim, exercised the way v1 callers used it.
 *
 * A v1 program that used a private key file, `proxy_ports`, `execCmd` and the
 * `ssh_tunnel_ready` event should keep working; only key management, ngrok
 * resolution and shell sessions are gone.
 */

const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { describe, it, before, after } = require('mocha');

const { SSHTunnelProxy } = require('../../build');
const { SSHTestBench, EchoServer, roundTrip, freePort } = require('../helpers/ssh-testbench');

describe('SSHTunnelProxy compatibility shim', function () {
  let bench;
  let echo;
  let proxy;
  let keyPath;

  before(async function () {
    bench = new SSHTestBench();
    await bench.start();
    echo = new EchoServer('v1:');
    await echo.start();

    const dir = mkdtempSync(join(tmpdir(), 'sshtun-legacy-'));
    keyPath = join(dir, 'id_ed25519');
    writeFileSync(keyPath, bench.clientKey.private, { mode: 0o600 });
  });

  after(async function () {
    if (proxy) await proxy.close();
    await echo.stop();
    await bench.stop();
  });

  it('connects with a v1 config object and emits ssh_tunnel_ready', async function () {
    const listenPort = await freePort();
    proxy = new SSHTunnelProxy();

    const events = [];
    proxy.on('ssh_tunnel_ready', () => events.push('ready'));
    proxy.on('status', (message) => events.push(`status:${message}`));
    proxy.on('error', () => {
      /* v1 callers attached an error listener */
    });

    await proxy.connectSSH(
      {
        username: 'tester',
        host: '127.0.0.1',
        port: String(bench.port),
        private_key_filename: keyPath,
        proxy_ports: [`${listenPort}:127.0.0.1:${echo.port}`],
        exec: ['whoami'],
      },
      { 22: true, 80: true, 443: true },
    );

    assert.deepEqual(
      events.filter((event) => event === 'ready'),
      ['ready'],
      'ssh_tunnel_ready must fire exactly once per connect',
    );
    assert.ok(events.some((event) => event.startsWith('status:')), 'the status event must still fire');
    assert.equal(await roundTrip(listenPort, 'legacy'), 'v1:legacy');
  });

  it('exposes the underlying ssh2 client and the v2 tunnel', function () {
    assert.ok(proxy.getClient(), 'getClient() still returns the ssh2 Client');
    assert.equal(proxy.getTunnel().isReady(), true);
  });

  it('adds more ports after connecting via setupProxyPorts', async function () {
    const listenPort = await freePort();
    await proxy.setupProxyPorts([`${listenPort}:127.0.0.1:${echo.port}`]);
    assert.equal(await roundTrip(listenPort, 'more'), 'v1:more');
  });

  it('adds reverse ports via setupRemotePorts', async function () {
    const statuses = await proxy.setupRemotePorts([`0:127.0.0.1:${echo.port}`]);
    assert.equal(statuses.length, 1);
    assert.equal(await roundTrip(statuses[0].assignedPort, 'rev'), 'v1:rev');
  });

  it('runs execCmd', async function () {
    const output = await proxy.execCmd('ls -al');
    assert.match(output, /ran:ls -al/);
  });

  it('reports status and tolerates the removed network callbacks', function () {
    const status = proxy.getStatus();
    assert.equal(status.state, 'ready');
    assert.ok(status.forwards.length >= 3);
    assert.doesNotThrow(() => proxy.onNetworkOnline());
    assert.doesNotThrow(() => proxy.onNetworkOffline());
  });

  it('rejects a v1 config that still asks for ngrok or the keychain', async function () {
    await assert.rejects(
      () => new SSHTunnelProxy().connectSSH({ username: 'x', host: '127.0.0.1', ngrok_api: 'k' }),
      /ngrok resolution was removed/,
    );
    await assert.rejects(
      () => new SSHTunnelProxy().connectSSH({ username: 'x', host: '127.0.0.1', service_name: 's' }),
      /keychain/,
    );
  });

  it('closes without throwing', async function () {
    await proxy.close();
    proxy = undefined;
  });
});
