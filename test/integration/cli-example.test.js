/*
 * examples/tunnel-cli.js, exercised as a real child process.
 *
 * The example is the documented replacement for v1's `ssh2-node rh2`, so it is
 * tested like any other entry point: a config file on disk, an alias on the command
 * line, and a real round trip through the forward the CLI opened.
 */

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdtempSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { describe, it, before, after } = require('mocha');

const { SSHTestBench, EchoServer, roundTrip, freePort } = require('../helpers/ssh-testbench');

const CLI = join(__dirname, '..', '..', 'examples', 'tunnel-cli.js');

/** Run the CLI to completion and collect its output. */
function runCli(args, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`CLI timed out. stderr:\n${stderr}`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.once('error', reject);
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** Start the CLI and resolve once it reports the tunnel is up. */
function startCli(args, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`CLI never came up. stderr:\n${stderr}`));
    }, timeoutMs);

    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (stderr.includes('tunnel is up')) {
        clearTimeout(timer);
        resolve({
          child,
          get stderr() {
            return stderr;
          },
          async stop() {
            const exited = new Promise((done) => child.once('close', done));
            child.kill('SIGINT');
            await exited;
          },
        });
      }
    });
    child.once('error', reject);
    child.once('close', (code) => {
      clearTimeout(timer);
      reject(new Error(`CLI exited early with code ${code}. stderr:\n${stderr}`));
    });
  });
}

describe('examples/tunnel-cli.js', function () {
  let bench;
  let echo;
  let dir;
  let keyPath;
  let configPath;
  let listenPort;

  before(async function () {
    bench = new SSHTestBench();
    await bench.start();
    echo = new EchoServer('cli:');
    await echo.start();

    dir = mkdtempSync(join(tmpdir(), 'sshtun-cli-'));
    keyPath = join(dir, 'id_ed25519');
    writeFileSync(keyPath, bench.clientKey.private, { mode: 0o600 });

    listenPort = await freePort();
    configPath = join(dir, 'config.json');
    writeFileSync(
      configPath,
      JSON.stringify([
        // A v1-shaped entry, as it would already exist on disk.
        {
          hostname: 'rh2',
          username: 'tester',
          host: '127.0.0.1',
          port: String(bench.port),
          private_key_filename: keyPath,
          proxy_ports: [`${listenPort}:127.0.0.1:${echo.port}`],
          whitelist: { 22: true, 80: true, 443: true },
          // Stale v2-removed keys: the CLI must warn and carry on.
          service_name: 'sshtun',
          ngrok_api: 'leftover-token',
        },
        // A v2-shaped entry.
        {
          name: 'rh2-v2',
          transport: {
            endpoint: { host: '127.0.0.1', port: bench.port },
            username: 'tester',
            privateKey: { source: 'file', value: keyPath },
          },
        },
        { name: 'off', host: '127.0.0.1', username: 'tester', disabled: true },
      ]),
    );
  });

  after(async function () {
    await echo.stop();
    await bench.stop();
  });

  it('lists both config generations', async function () {
    const { code, stdout } = await runCli(['-F', configPath, '--list']);
    assert.equal(code, 0);
    assert.match(stdout, /rh2\s+v1\s+127\.0\.0\.1:\d+\s+1 forward\(s\)/);
    assert.match(stdout, /rh2-v2\s+v2/);
    assert.match(stdout, /off\s+.*\(disabled\)/);
  });

  it('brings up a v1 alias and carries traffic, as `ssh2-node rh2` did', async function () {
    const cli = await startCli(['-F', configPath, 'rh2']);
    try {
      assert.match(cli.stderr, /connected to tester@127\.0\.0\.1:\d+/);
      assert.match(cli.stderr, /L 127\.0\.0\.1:\d+ -> 127\.0\.0\.1:\d+ {2}\[active\]/);
      assert.equal(await roundTrip(listenPort, 'via-cli'), 'cli:via-cli');
    } finally {
      await cli.stop();
    }
  });

  it('warns about removed v1 keys instead of refusing to start', async function () {
    const cli = await startCli(['-F', configPath, 'rh2']);
    try {
      assert.match(cli.stderr, /warning: "ngrok_api" is ignored in v2/);
      assert.match(cli.stderr, /warning: "service_name" is ignored in v2/);
    } finally {
      await cli.stop();
    }
  });

  it('releases the port when interrupted', async function () {
    const cli = await startCli(['-F', configPath, 'rh2']);
    await cli.stop();
    await assert.rejects(() => roundTrip(listenPort, 'gone'));
  });

  it('overrides forwards from the command line with -L', async function () {
    const override = await freePort();
    const cli = await startCli([
      '-F',
      configPath,
      'rh2-v2',
      '-L',
      `${override}:127.0.0.1:${echo.port}`,
    ]);
    try {
      assert.equal(await roundTrip(override, 'override'), 'cli:override');
      await assert.rejects(
        () => roundTrip(listenPort, 'not-this-one'),
        'the config entry\'s own forward should not be open',
      );
    } finally {
      await cli.stop();
    }
  });

  it('connects ad hoc from user@host with no config entry', async function () {
    const adHocPort = await freePort();
    const cli = await startCli([
      'tester@127.0.0.1',
      '-p',
      String(bench.port),
      '-i',
      keyPath,
      '-L',
      `${adHocPort}:127.0.0.1:${echo.port}`,
    ]);
    try {
      assert.equal(await roundTrip(adHocPort, 'adhoc'), 'cli:adhoc');
    } finally {
      await cli.stop();
    }
  });

  it('runs a command after `--` and exits with its status', async function () {
    const { code, stdout } = await runCli(['-F', configPath, 'rh2-v2', '--', 'uname', '-a']);
    assert.equal(code, 0);
    assert.match(stdout, /ran:uname -a/);
  });

  it('reports a missing alias, a disabled alias and a bad option', async function () {
    const missing = await runCli(['-F', configPath, 'nope']);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /no entry named "nope"/);
    assert.match(missing.stderr, /Available: rh2, rh2-v2, off/);

    const disabled = await runCli(['-F', configPath, 'off']);
    assert.equal(disabled.code, 1);
    assert.match(disabled.stderr, /is disabled/);

    const badOption = await runCli(['-F', configPath, '--nonsense']);
    assert.equal(badOption.code, 1);
    assert.match(badOption.stderr, /unknown option --nonsense/);

    const noTarget = await runCli(['-F', configPath]);
    assert.equal(noTarget.code, 2);
  });

  it('explains an unreachable SSH endpoint instead of dumping a stack trace', async function () {
    const deadPort = await freePort();
    const { code, stderr } = await runCli([
      `tester@127.0.0.1`,
      '-p',
      String(deadPort),
      '-i',
      keyPath,
      '--no-reconnect',
    ]);
    assert.equal(code, 1);
    assert.doesNotMatch(stderr, /at Object\.|node:internal/, 'no raw stack trace');
    assert.match(stderr, /error \[/);
  });
});
