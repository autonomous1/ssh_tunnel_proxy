/*
todo:
describe tests for setting up connection and proxy ports
*/

const assert = require('assert');
const { describe, it } = require('mocha');
const fs = require('fs');
const { SSHTunnelProxy, KeypairStorage, NgrokApi } = require('..');
//const sinon = require('sinon');
//const {EventEmitter} = require('events');


// get config file containing api keys
const homedir = require('os').homedir();
let config = {};
let opts = {};
try {
  const config_file = homedir + '/.config/ssh_tunnel_proxy/config.json';
  if (fs.existsSync(config_file)) {
    config = JSON.parse(fs.readFileSync(config_file), 'utf8');
    opts = config[0];
  } else {
    config = null;
    opts = null;
  }
} catch (err) {
  // if no config, disable tests that require config opts
  config = null;
  opts = null;
}

const sshTunnelProxy = new SSHTunnelProxy();
const keypairStorage = new KeypairStorage();

const whitelist = {
  80: true,
  443: true,
  22: true
}

// port value validation tests
describe('Validate ports', function () {
  //const validate_port_number = sshTunnelProxy.__get__('validate_port_number');
  it('valid port number 1024', function () {
    assert(sshTunnelProxy.validate_port_number(1024, whitelist), 'should be valid');
  });
  it('valid port number 80', function () {
    assert(sshTunnelProxy.validate_port_number(80, whitelist), 'should be valid');
  });
  it('invalid port number -1', function () {
    assert.equal(false, sshTunnelProxy.validate_port_number(-1, whitelist), 'should be invalid');
  });
  it('invalid port number 65536', function () {
    assert.equal(false, sshTunnelProxy.validate_port_number(65536, whitelist), 'should be invalid');
  });
  it('invalid system port number 137', function () {
    assert.equal(false, sshTunnelProxy.validate_port_number(137, whitelist), 'should be invalid');
  });
  it('port number nan', function () {
    assert.equal(false, sshTunnelProxy.validate_port_number('nan', whitelist), 'should be invalid');
  });
});

// local forward format and value validation test
describe('Validate local forwards', function () {
  //const validate_local_forward = sshTunnelProxy.__get__('validate_local_forward');
  var local_forward = [
    '8080:127.0.0.1:80',
    '9000:192.168.43.5:9000',
    '9000:192.168.43.5',
    '192.168.43.5:9000',
    '8137:127.0.0.1:137',
    '-1:127.0.0.1:65537',
  ];
  it('valid local forward to 80 ' + local_forward[0], function () {
    assert(() => { return sshTunnelProxy.validate_local_forward([local_forward[0]], whitelist) }, 'should be valid');
  });
  it('valid local forward to 9000 ' + local_forward[1], function () {
    assert(() => { return sshTunnelProxy.validate_local_forward([local_forward[1]], whitelist) }, 'should be valid');
  });
  it('invalid local forward format ' + local_forward[2], function () {
    const err = {
      message: 'Invalid local forward'
    };
    assert.throws(() => { sshTunnelProxy.validate_local_forward([local_forward[2]], whitelist) }, err);
  });
  it('invalid local forward format ' + local_forward[3], function () {
    const err = {
      message: 'Invalid local forward'
    };
    assert.throws(() => { sshTunnelProxy.validate_local_forward([local_forward[3]], whitelist) }, err, 'should be invalid');
  });
  it('invalid local forward system port ' + local_forward[4], function () {
    const err = {
      message: 'Invalid local forward'
    };
    assert.throws(() => { sshTunnelProxy.validate_local_forward([local_forward[4]], whitelist) }, err, 'should be invalid');
  });
  it('invalid local forward port range ' + local_forward[5], function () {
    const err = {
      message: 'Invalid local forward'
    };
    assert.throws(() => { sshTunnelProxy.validate_local_forward([local_forward[5]], whitelist) }, err, 'should be invalid');
  });
});

// generate, store and retrieve private key test
/*
describe('Store and retrieve private key in system keychain', function () {
  const service_name = 'ssh_proxy_tunnel';
  const account = 'test';
  const keypair = keypairStorage.generate_keypair();
  it('generated key should contain a private key', function () {
    assert(keypair.private_key, 'should not be empty');
  });
  it('generated key should contain a public key', function () {
    assert(keypair.public_key, 'should not be empty');
  });
  it('should store generated private key', () => {
    return keypairStorage.set_keypair(service_name, account, keypair.private_key).then(result => {
      assert.equal(result, undefined, 'should not return error');
    })
  });
  it('stored private key should match generated key', () => {
    return keypairStorage.get_keypair(service_name, account).then(stored_key => {
      assert.equal(stored_key, keypair.private_key, 'should match');
    });
  });
  it('stored public key should match generated key', () => {
    return keypairStorage.get_public_key_from_keychain(service_name, account).then(stored_key => {
      assert.equal(stored_key, keypair.public_key, 'should match');
    });
  });
  it('remove key should return true', () => {
    return keypairStorage.delete_keypair(service_name, account).then((result) => {
      assert(result, 'should return true');
    });
  });
  it('retrieve stored private key after delete should return null', () => {
    return keypairStorage.get_keypair(service_name, account).then((result) => {
      assert.equal(result, null, 'should return null');
    });
  });
  it('retrieve stored public key after delete should return null', () => {
    return keypairStorage.get_public_key_from_keychain(service_name, account).then((result) => {
      assert.equal(result, null, 'should return null');
    });
  });
});
*/
// only run ngrok test if config file is specified and has ngrok key
if (opts && opts.ngrok_api) {
  const ngrokApi = new NgrokApi(opts.ngrok_api);
  describe('Get ngrok hostport', function () {
    //const parse_ngrok_hostport = ngrok_service.__get__('parse_ngrok_hostport');
    var test_endpoint = [{
      hostport: '8.tcp.ngrok.io:17632'
    }];
    var result_opts = ngrokApi.parse_ngrok_hostport(test_endpoint, opts);
    it('host should match 8.tcp.ngrok.io', function () {
      assert.equal(result_opts.host, '8.tcp.ngrok.io');
    });
    it('port should match 17632', function () {
      assert.equal(result_opts.port, '17632');
    });
    it('host, port should be obtained from api', async () => {
      const result = await ngrokApi.get_hostport(opts);
      assert(result.host, 'host should exist');
      assert(result.port, 'port should exist');
    }, (err) => {
      assert.equal(err, null);
    });

  });
}
