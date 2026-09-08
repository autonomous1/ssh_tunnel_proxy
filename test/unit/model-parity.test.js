/*
 * model-parity.test.js
 *
 * The .proto file is the cross-language source of truth, and model.ts is a
 * hand-written projection of it. This test fails the build if the two drift, so a
 * future Python runtime generated from the proto can never encounter a state the
 * TypeScript runtime does not know about, or vice versa.
 */

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { describe, it } = require('mocha');

const {
  CONNECTION_STATES,
  CREDENTIAL_SOURCES,
  FORWARD_DIRECTIONS,
  FORWARD_STATES,
  REACHABILITY_VALUES,
  TUNNEL_STATES,
  TUNNEL_ERROR_CODES,
} = require('../../build');

const PROTO_PATH = join(__dirname, '..', '..', 'proto', 'sshtunnel', 'v1', 'tunnel.proto');
const proto = readFileSync(PROTO_PATH, 'utf8');

/** Collect the value names of one proto enum, dropping the *_UNSPECIFIED zero. */
function protoEnumValues(enumName, prefix) {
  const match = new RegExp(`enum\\s+${enumName}\\s*\\{([^}]*)\\}`, 'm').exec(proto);
  assert.ok(match, `enum ${enumName} not found in tunnel.proto`);
  return match[1]
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('//'))
    .map((line) => /^([A-Z0-9_]+)\s*=/.exec(line))
    .filter(Boolean)
    .map((m) => m[1])
    .filter((name) => !name.endsWith('UNSPECIFIED'))
    .map((name) => {
      assert.ok(
        name.startsWith(prefix),
        `${enumName} value ${name} should start with ${prefix}`,
      );
      return name.slice(prefix.length).toLowerCase();
    });
}

function assertParity(enumName, prefix, tsValues) {
  const fromProto = protoEnumValues(enumName, prefix).sort();
  const fromTs = [...tsValues].sort();
  assert.deepEqual(
    fromTs,
    fromProto,
    `${enumName} differs between tunnel.proto and model.ts`,
  );
}

describe('proto / TypeScript model parity', function () {
  it('TunnelState', function () {
    assertParity('TunnelState', 'TUNNEL_STATE_', TUNNEL_STATES);
  });

  it('ForwardState', function () {
    assertParity('ForwardState', 'FORWARD_STATE_', FORWARD_STATES);
  });

  it('ConnectionState', function () {
    assertParity('ConnectionState', 'CONNECTION_STATE_', CONNECTION_STATES);
  });

  it('ForwardDirection', function () {
    assertParity('ForwardDirection', 'FORWARD_DIRECTION_', FORWARD_DIRECTIONS);
  });

  it('CredentialRef.Source', function () {
    assertParity('Source', 'SOURCE_', CREDENTIAL_SOURCES);
  });

  it('SshTransport.Reachability', function () {
    assertParity('Reachability', 'REACHABILITY_', REACHABILITY_VALUES);
  });

  it('ErrorRaised.Code matches the runtime error taxonomy', function () {
    const fromProto = protoEnumValues('Code', 'CODE_').map((value) => value.toUpperCase()).sort();
    assert.deepEqual([...TUNNEL_ERROR_CODES].sort(), fromProto);
  });

  it('does not reference removed v1 concepts', function () {
    for (const banned of ['keytar', 'keychain', 'Keypair', 'ngrok_api', 'NgrokApi']) {
      assert.ok(
        !proto.includes(banned),
        `tunnel.proto should not mention the removed concept "${banned}"`,
      );
    }
  });
});
