const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync } = require('node:fs');
const { tmpdir, homedir } = require('node:os');
const { join } = require('node:path');
const { describe, it } = require('mocha');

const {
  credential,
  expandHome,
  resolveAgentSocket,
  resolveCredential,
} = require('../../build');

describe('expandHome', function () {
  it('expands a leading tilde only', function () {
    assert.equal(expandHome('~'), homedir());
    assert.equal(expandHome('~/.ssh/id_ed25519'), join(homedir(), '.ssh/id_ed25519'));
    assert.equal(expandHome('/etc/keys/id_ed25519'), '/etc/keys/id_ed25519');
    assert.equal(expandHome('./relative'), './relative');
  });
});

describe('resolveCredential', function () {
  it('returns undefined for an absent ref', async function () {
    assert.equal(await resolveCredential(undefined), undefined);
  });

  it('resolves an inline value', async function () {
    assert.equal(await resolveCredential(credential.inline('secret')), 'secret');
  });

  it('resolves an environment variable', async function () {
    process.env.SSH_TUNNEL_TEST_KEY = 'from-env';
    assert.equal(await resolveCredential(credential.env('SSH_TUNNEL_TEST_KEY')), 'from-env');
    delete process.env.SSH_TUNNEL_TEST_KEY;
  });

  it('fails with a coded error when the variable is unset', async function () {
    await assert.rejects(
      () => resolveCredential(credential.env('SSH_TUNNEL_DEFINITELY_UNSET')),
      (err) => err.code === 'CREDENTIAL_UNRESOLVED',
    );
  });

  it('reads a file and expands the tilde form', async function () {
    const dir = mkdtempSync(join(tmpdir(), 'sshtun-'));
    const path = join(dir, 'key');
    writeFileSync(path, 'key-bytes');
    const value = await resolveCredential(credential.file(path));
    assert.equal(value.toString(), 'key-bytes');
  });

  it('rejects a relative path', async function () {
    await assert.rejects(
      () => resolveCredential(credential.file('relative/key')),
      /must be absolute/,
    );
  });

  it('reports a missing file with a coded error', async function () {
    await assert.rejects(
      () => resolveCredential(credential.file('/nonexistent/path/to/key')),
      (err) => err.code === 'CREDENTIAL_UNRESOLVED',
    );
  });

  it('requires a resolver for callback refs', async function () {
    await assert.rejects(
      () => resolveCredential(credential.callback('vault')),
      /no credentialResolver was supplied/,
    );
    const value = await resolveCredential(credential.callback('vault'), {
      resolver: (ref) => `resolved:${ref.value}`,
    });
    assert.equal(value, 'resolved:vault');
  });
});

describe('resolveAgentSocket', function () {
  it('prefers an explicit path, then SSH_AUTH_SOCK', function () {
    assert.equal(resolveAgentSocket(credential.agent('/tmp/agent.sock')), '/tmp/agent.sock');
    process.env.SSH_AUTH_SOCK = '/tmp/from-env.sock';
    assert.equal(resolveAgentSocket(credential.agent()), '/tmp/from-env.sock');
    delete process.env.SSH_AUTH_SOCK;
  });

  it('ignores non-agent refs', function () {
    assert.equal(resolveAgentSocket(credential.file('/tmp/key')), undefined);
    assert.equal(resolveAgentSocket(undefined), undefined);
  });
});
