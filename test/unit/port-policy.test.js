const assert = require('node:assert/strict');
const { describe, it } = require('mocha');

const {
  checkPort,
  isValidHost,
  isValidPort,
  parsePort,
  assertPortAllowed,
  isTunnelError,
} = require('../../build');

const policy = { allowedPrivilegedPorts: [22, 80, 443] };

describe('isValidPort', function () {
  it('accepts the port range boundaries', function () {
    assert.equal(isValidPort(1), true);
    assert.equal(isValidPort(1024), true);
    assert.equal(isValidPort(65535), true);
  });

  it('rejects out-of-range values', function () {
    assert.equal(isValidPort(0), false);
    assert.equal(isValidPort(-1), false);
    assert.equal(isValidPort(65536), false);
  });

  it('rejects non-integers, which v1 accepted via parseInt', function () {
    assert.equal(isValidPort(22.5), false);
    assert.equal(isValidPort(Number.NaN), false);
    assert.equal(isValidPort('8080'), false);
  });
});

describe('parsePort', function () {
  it('parses a bare decimal port', function () {
    assert.equal(parsePort('8080'), 8080);
  });

  it('rejects the values parseInt would silently truncate', function () {
    assert.equal(parsePort('80abc'), undefined);
    assert.equal(parsePort('22.5'), undefined);
    assert.equal(parsePort(' 80'), undefined);
    assert.equal(parsePort('0x50'), undefined);
    assert.equal(parsePort(''), undefined);
    assert.equal(parsePort('+80'), undefined);
  });

  it('rejects out-of-range numerals', function () {
    assert.equal(parsePort('0'), undefined);
    assert.equal(parsePort('65536'), undefined);
  });
});

describe('checkPort privileged policy', function () {
  it('accepts the first unprivileged port with no policy at all', function () {
    assert.equal(checkPort(1024, 'local-listen').allowed, true);
  });

  it('accepts an explicitly permitted privileged port', function () {
    assert.equal(checkPort(80, 'remote-target', policy).allowed, true);
  });

  it('rejects an unlisted privileged port', function () {
    const result = checkPort(137, 'remote-target', policy);
    assert.equal(result.allowed, false);
    assert.match(result.reason, /privileged port 137/);
  });

  it('rejects every privileged port when no allowlist is given', function () {
    assert.equal(checkPort(80, 'remote-target').allowed, false);
  });
});

describe('checkPort role allowlists', function () {
  it('separates local listen policy from remote target policy', function () {
    const split = {
      allowedLocalListenPorts: [8280],
      allowedRemoteTargetPorts: [8080],
    };
    assert.equal(checkPort(8280, 'local-listen', split).allowed, true);
    assert.equal(checkPort(8080, 'local-listen', split).allowed, false);
    assert.equal(checkPort(8080, 'remote-target', split).allowed, true);
    assert.equal(checkPort(8280, 'remote-target', split).allowed, false);
  });

  it('treats an empty allowlist as no restriction', function () {
    assert.equal(checkPort(9000, 'local-listen', { allowedLocalListenPorts: [] }).allowed, true);
  });

  it('allows port 0 only for a peer-assigned remote bind', function () {
    assert.equal(checkPort(0, 'remote-bind').allowed, true);
    assert.equal(checkPort(0, 'local-listen').allowed, false);
    assert.equal(checkPort(0, 'remote-target').allowed, false);
  });
});

describe('assertPortAllowed', function () {
  it('throws a coded TunnelError', function () {
    try {
      assertPortAllowed(137, 'remote-target', policy, 'demo');
      assert.fail('expected a throw');
    } catch (err) {
      assert.ok(isTunnelError(err));
      assert.equal(err.code, 'PORT_NOT_PERMITTED');
      assert.equal(err.forwardId, 'demo');
    }
  });

  it('returns the port when permitted', function () {
    assert.equal(assertPortAllowed(8080, 'remote-target'), 8080);
  });
});

describe('isValidHost', function () {
  it('accepts hostnames and IP literals', function () {
    assert.equal(isValidHost('127.0.0.1'), true);
    assert.equal(isValidHost('localhost'), true);
    assert.equal(isValidHost('192.168.2.1'), true);
    assert.equal(isValidHost('camera-01.lan'), true);
    assert.equal(isValidHost('::1'), true);
    assert.equal(isValidHost('[::1]'), true);
  });

  it('rejects empty, padded and URL-shaped values', function () {
    assert.equal(isValidHost(''), false);
    assert.equal(isValidHost(' 127.0.0.1'), false);
    assert.equal(isValidHost('http://127.0.0.1'), false);
    assert.equal(isValidHost('127.0.0.1/8'), false);
    assert.equal(isValidHost(undefined), false);
  });
});
