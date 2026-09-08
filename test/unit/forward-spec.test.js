const assert = require('node:assert/strict');
const { describe, it } = require('mocha');

const {
  parseLocalForwardSpec,
  parseRemoteForwardSpec,
  parseAndValidateLocalForward,
  parseAndValidateRemoteForward,
  validateLocalForward,
  describeLocalForward,
  describeRemoteForward,
  isTunnelError,
} = require('../../build');

const policy = { allowedPrivilegedPorts: [22, 80, 443] };

describe('parseLocalForwardSpec', function () {
  it('parses the v1 three-field form and defaults the bind address', function () {
    const forward = parseLocalForwardSpec('8280:127.0.0.1:8080');
    assert.deepEqual(forward.listen, { host: '127.0.0.1', port: 8280 });
    assert.deepEqual(forward.target, { host: '127.0.0.1', port: 8080 });
  });

  it('parses the four-field form with an explicit bind address', function () {
    const forward = parseLocalForwardSpec('0.0.0.0:8280:192.168.2.1:22');
    assert.deepEqual(forward.listen, { host: '0.0.0.0', port: 8280 });
    assert.deepEqual(forward.target, { host: '192.168.2.1', port: 22 });
  });

  it('rejects an incomplete specification instead of relying on NaN', function () {
    assert.throws(
      () => parseLocalForwardSpec('9000:192.168.43.5'),
      /expected localPort:remoteHost:remotePort/,
    );
    assert.throws(() => parseLocalForwardSpec('192.168.43.5:9000'), /got 2 colon-separated fields/);
  });

  it('rejects more than four fields', function () {
    assert.throws(() => parseLocalForwardSpec('a:1:b:2:c'), /got 5 colon-separated fields/);
  });

  it('rejects an empty remote host', function () {
    assert.throws(() => parseLocalForwardSpec('8080::80'), /remote host is required/);
  });

  it('rejects an empty bind address in the four-field form', function () {
    assert.throws(() => parseLocalForwardSpec(':8080:127.0.0.1:80'), /bind address is empty/);
  });

  it('rejects nonnumeric and malformed ports', function () {
    assert.throws(() => parseLocalForwardSpec('abc:127.0.0.1:8080'), /local listen port/);
    assert.throws(() => parseLocalForwardSpec('80abc:127.0.0.1:8080'), /local listen port/);
    assert.throws(() => parseLocalForwardSpec('8080:127.0.0.1:'), /remote target port/);
    assert.throws(() => parseLocalForwardSpec('-1:127.0.0.1:65537'), /local listen port/);
    assert.throws(() => parseLocalForwardSpec('8080:127.0.0.1:65536'), /remote target port/);
  });

  it('rejects non-string input', function () {
    assert.throws(() => parseLocalForwardSpec(undefined), /Invalid forward/);
    assert.throws(() => parseLocalForwardSpec(8080), /Invalid forward/);
  });
});

describe('parseAndValidateLocalForward', function () {
  it('accepts the verified zrok/Termux forward', function () {
    const forward = parseAndValidateLocalForward('8280:127.0.0.1:8080', policy);
    assert.equal(forward.listen.port, 8280);
    assert.equal(forward.target.port, 8080);
    assert.equal(forward.id, '8280:127.0.0.1:8080');
  });

  it('accepts a phone-network SSH target on an allowlisted privileged port', function () {
    const forward = parseAndValidateLocalForward('8122:192.168.2.1:22', policy);
    assert.deepEqual(forward.target, { host: '192.168.2.1', port: 22 });
  });

  it('rejects an unapproved privileged target port', function () {
    try {
      parseAndValidateLocalForward('8137:127.0.0.1:137', policy);
      assert.fail('expected a throw');
    } catch (err) {
      assert.ok(isTunnelError(err));
      assert.equal(err.code, 'PORT_NOT_PERMITTED');
    }
  });

  it('enforces allowedRemoteHosts when set', function () {
    try {
      parseAndValidateLocalForward('8280:10.0.0.5:8080', { allowedRemoteHosts: ['127.0.0.1'] });
      assert.fail('expected a throw');
    } catch (err) {
      assert.equal(err.code, 'HOST_NOT_PERMITTED');
    }
  });
});

describe('parseRemoteForwardSpec', function () {
  it('defaults the peer bind address in the three-field form', function () {
    const forward = parseRemoteForwardSpec('8443:127.0.0.1:8080');
    assert.deepEqual(forward.bind, { host: 'localhost', port: 8443 });
    assert.deepEqual(forward.target, { host: '127.0.0.1', port: 8080 });
  });

  it('accepts an explicit bind address', function () {
    const forward = parseRemoteForwardSpec('0.0.0.0:8443:127.0.0.1:8080');
    assert.deepEqual(forward.bind, { host: '0.0.0.0', port: 8443 });
  });

  it('accepts bind port 0, meaning peer-assigned', function () {
    const forward = parseRemoteForwardSpec('0:127.0.0.1:8080');
    assert.equal(forward.bind.port, 0);
  });

  it('validates bind port 0 under a policy', function () {
    const forward = parseAndValidateRemoteForward('0:127.0.0.1:8080', policy);
    assert.equal(forward.bind.port, 0);
  });

  it('rejects a malformed bind port', function () {
    assert.throws(() => parseRemoteForwardSpec('84x43:127.0.0.1:8080'), /bind port/);
  });
});

describe('validateLocalForward on structured input', function () {
  it('defaults the listen host and derives an id', function () {
    const forward = validateLocalForward({
      listen: { host: '127.0.0.1', port: 8280 },
      target: { host: '127.0.0.1', port: 8080 },
    });
    assert.equal(forward.id, 'L:127.0.0.1:8280->127.0.0.1:8080');
  });

  it('preserves a caller-supplied semantic id', function () {
    const forward = validateLocalForward({
      id: 'termux-web',
      listen: { host: '127.0.0.1', port: 8280 },
      target: { host: '127.0.0.1', port: 8080 },
    });
    assert.equal(forward.id, 'termux-web');
  });

  it('rejects a string port that slipped through from JSON', function () {
    assert.throws(
      () =>
        validateLocalForward({
          listen: { host: '127.0.0.1', port: '8280' },
          target: { host: '127.0.0.1', port: 8080 },
        }),
      /not a valid TCP port/,
    );
  });
});

describe('describe helpers', function () {
  it('renders stable ids', function () {
    assert.equal(
      describeLocalForward({ listen: { host: '127.0.0.1', port: 1 }, target: { host: 'h', port: 2 } }),
      'L:127.0.0.1:1->h:2',
    );
    assert.equal(
      describeRemoteForward({ bind: { host: 'localhost', port: 1 }, target: { host: 'h', port: 2 } }),
      'R:localhost:1->h:2',
    );
  });
});
