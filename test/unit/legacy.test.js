const assert = require('node:assert/strict');
const { describe, it } = require('mocha');

const {
  SSHTunnelProxy,
  legacyConfigToTunnelConfig,
  whitelistToPortPolicy,
} = require('../../build');

describe('whitelistToPortPolicy', function () {
  it('maps the v1 whitelist object onto allowedPrivilegedPorts', function () {
    assert.deepEqual(whitelistToPortPolicy({ 22: true, 80: true, 443: true }), {
      allowedPrivilegedPorts: [22, 80, 443],
    });
  });

  it('ignores unprivileged and nonnumeric keys', function () {
    assert.deepEqual(whitelistToPortPolicy({ 8080: true, nope: true }), {});
  });

  it('treats null and undefined as no policy', function () {
    assert.deepEqual(whitelistToPortPolicy(null), {});
    assert.deepEqual(whitelistToPortPolicy(undefined), {});
  });
});

describe('legacyConfigToTunnelConfig', function () {
  const base = {
    username: 'u0_a272',
    host: '127.0.0.1',
    port: '9191',
    private_key_filename: '~/.ssh/id_ed25519',
    proxy_ports: ['8280:127.0.0.1:8080'],
  };

  it('translates the verified zrok/Termux config', function () {
    const config = legacyConfigToTunnelConfig(base);
    assert.deepEqual(config.transport.endpoint, { host: '127.0.0.1', port: 9191 });
    assert.equal(config.transport.username, 'u0_a272');
    assert.deepEqual(config.transport.privateKey, {
      source: 'file',
      value: '~/.ssh/id_ed25519',
    });
  });

  it('falls back to hostname and port 22', function () {
    const config = legacyConfigToTunnelConfig({ username: 'me', hostname: 'relay.example' });
    assert.deepEqual(config.transport.endpoint, { host: 'relay.example', port: 22 });
  });

  it('carries the whitelist through as a port policy', function () {
    const config = legacyConfigToTunnelConfig(base, { 80: true });
    assert.deepEqual(config.portPolicy, { allowedPrivilegedPorts: [80] });
  });

  it('prefers an inline private key when no filename is given', function () {
    const config = legacyConfigToTunnelConfig({ ...base, private_key_filename: null, private_key: 'KEY' });
    assert.deepEqual(config.transport.privateKey, { source: 'inline', value: 'KEY' });
  });

  it('drops an empty password rather than attempting password auth', function () {
    const config = legacyConfigToTunnelConfig({ ...base, password: '' });
    assert.equal(config.transport.password, undefined);
  });

  it('rejects ngrok_api with migration advice', function () {
    assert.throws(
      () => legacyConfigToTunnelConfig({ ...base, ngrok_api: 'token' }),
      /ngrok resolution was removed[\s\S]*MIGRATION\.md/,
    );
  });

  it('rejects keychain service_name with migration advice', function () {
    assert.throws(
      () => legacyConfigToTunnelConfig({ ...base, service_name: 'sshtun' }),
      /system-keychain key storage was removed/,
    );
  });

  it('rejects shell with migration advice', function () {
    assert.throws(() => legacyConfigToTunnelConfig({ ...base, shell: true }), /shell support/);
  });

  it('rejects a missing host and a nonsense port', function () {
    assert.throws(() => legacyConfigToTunnelConfig({ username: 'me' }), /host .*is required/);
    assert.throws(() => legacyConfigToTunnelConfig({ ...base, port: 'abc' }), /Invalid SSH port/);
  });
});

describe('SSHTunnelProxy v1 validation methods', function () {
  const proxy = new SSHTunnelProxy();
  const whitelist = { 22: true, 80: true, 443: true };

  it('keeps the v1 port validation contract', function () {
    assert.equal(proxy.validate_port_number(1024, whitelist), true);
    assert.equal(proxy.validate_port_number(80, whitelist), true);
    assert.equal(proxy.validate_port_number(-1, whitelist), false);
    assert.equal(proxy.validate_port_number(65536, whitelist), false);
    assert.equal(proxy.validate_port_number(137, whitelist), false);
  });

  it('keeps the v1 local forward validation contract', function () {
    assert.equal(proxy.validate_local_forward(null, whitelist), true);
    assert.equal(proxy.validate_local_forward(['8080:127.0.0.1:80'], whitelist), true);
    assert.equal(proxy.validate_local_forward(['9000:192.168.43.5:9000'], whitelist), true);
    assert.throws(() => proxy.validate_local_forward(['9000:192.168.43.5'], whitelist));
    assert.throws(() => proxy.validate_local_forward(['192.168.43.5:9000'], whitelist));
    assert.throws(() => proxy.validate_local_forward(['8137:127.0.0.1:137'], whitelist));
    assert.throws(() => proxy.validate_local_forward(['-1:127.0.0.1:65537'], whitelist));
  });

  it('refuses to act before connectSSH', function () {
    assert.throws(() => new SSHTunnelProxy().getStatus(), /Call connectSSH/);
  });
});
