/*
todo:
add generate and store keys test
add ngrok api test with stored api key in ssh_tunnel_proxy config
to run ssh tunnel api tests edit config.json and provide api keys for each service
*/
const assert = require('assert');
const rewire = require('rewire');
const fs = require('fs');
const path = require('path');
const os = require('os');
const sinon = require('sinon');

const { connect_ssh, get_event_hook } = require('../lib/index.js');
const { store_private_key, retrieve_private_key, generate_and_store_keypair, get_public_key_from_keychain, remove_keypair, generate_keypair } = require('../lib/keypair_storage');
const { get_hostport } = require('../lib/ngrok_service');

var main = rewire('../lib/index.js');
var ngrok_service = rewire('../lib/ngrok_service.js');
var keypair_storage = rewire('../lib/keypair_storage.js');

// get config file containing api keys
var homedir = require('os').homedir();
var opts = JSON.parse(fs.readFileSync(path.join(homedir, '.config/ssh_tunnel_proxy/config.json')), 'utf8');

var myEmitter = get_event_hook();

const whitelist = {
  80: true,
  443: true,
  22: true
}

// port value validation tests
describe('Validate ports', function () {
  const validate_port_number = main.__get__('validate_port_number');
  it('valid port number 1024', function () {
    assert(validate_port_number(1024, whitelist), 'should be valid');
  });
  it('valid port number 80', function () {
    assert(validate_port_number(80, whitelist), 'should be valid');
  });
  it('invalid port number -1', function () {
    assert.equal(false, validate_port_number(-1, whitelist), 'should be invalid');
  });
  it('invalid port number 65536', function () {
    assert.equal(false, validate_port_number(65536, whitelist), 'should be invalid');
  });
  it('invalid system port number 137', function () {
    assert.equal(false, validate_port_number(137, whitelist), 'should be invalid');
  });
  it('port number nan', function () {
    assert.equal(false, validate_port_number('nan', whitelist), 'should be invalid');
  });
});

// local forward format and value validation test
describe('Validate local forwards', function () {
  const validate_local_forward = main.__get__('validate_local_forward');
  var local_forward = [
    '8080:127.0.0.1:80',
    '9000:192.168.43.5:9000',
    '9000:192.168.43.5',
    '192.168.43.5:9000',
    '8137:127.0.0.1:137',
    '-1:127.0.0.1:65537',
  ];
  it('valid local forward to 80 ' + local_forward[0], function () {
    assert(() => { return validate_local_forward([local_forward[0]], whitelist) }, 'should be valid');
  });
  it('valid local forward to 9000 ' + local_forward[1], function () {
    assert(() => { return validate_local_forward([local_forward[1]], whitelist) }, 'should be valid');
  });
  it('invalid local forward format ' + local_forward[2], function () {
    const err = {
      message: 'Invalid local forward',
      info: {
        local_ports: '',
        remote_ports: '',
      }
    };
    assert.throws(() => { validate_local_forward([local_forward[2]], whitelist) }, err);
  });
  it('invalid local forward format ' + local_forward[3], function () {
    const err = {
      message: 'Invalid local forward',
      info: {
        local_ports: '192.168.43.5',
        remote_ports: '',
      }
    };
    assert.throws(() => { validate_local_forward([local_forward[3]], whitelist) }, err, 'should be invalid');
  });
  it('invalid local forward system port ' + local_forward[4], function () {
    const err = {
      message: 'Invalid local forward',
      info: {
        local_ports: '',
        remote_ports: '137',
      }
    };
    assert.throws(() => { validate_local_forward([local_forward[4]], whitelist) }, err, 'should be invalid');
  });
  it('invalid local forward port range ' + local_forward[5], function () {
    const err = {
      message: 'Invalid local forward',
      info: {
        local_ports: '-1',
        remote_ports: '65537',
      }
    };
    assert.throws(() => { validate_local_forward([local_forward[5]], whitelist) }, err, 'should be invalid');
  });
});

// generate, store and retrieve private key test
describe('Store and retrieve private key in system keychain', function () {
  const service_name = 'ssh_proxy_tunnel';
  const account = 'test';
  const keypair = generate_keypair();
  it('generated key should contain a private key', function () {
    assert(keypair.private_key, 'should not be empty');
  });
  it('generated key should contain a public key', function () {
    assert(keypair.public_key, 'should not be empty');
  });
  it('should store generated private key', () => {
    return store_private_key(service_name, account, keypair.private_key).then(result => {
      assert.equal(result, undefined, 'should not return error');
    })
  });
  it('stored private key should match generated key', () => {
    return retrieve_private_key(service_name, account).then(stored_key => {
      assert.equal(stored_key, keypair.private_key, 'should match');
    });
  });
  it('stored public key should match generated key', () => {
    return get_public_key_from_keychain(service_name, account).then(stored_key => {
      assert.equal(stored_key, keypair.public_key, 'should match');
    });
  });
  it('remove key should return true', () => {
    return remove_keypair(service_name, account).then(result => {
      assert('should return true');
    });
  });
  it('retrieve stored private key after delete should return null', () => {
    return retrieve_private_key(service_name, account).then((result) => {
      assert.equal(result, null, 'should return null');
    });
  });
  it('retrieve stored public key after delete should return null', () => {
    return get_public_key_from_keychain(service_name, account).then((result) => {
      assert.equal(result, null, 'should return null');
    });
  });
});

/*
// generate and store private key test
describe('', function () {
  it('', function () {
    assert('', '');
  });
});
*/

describe('Get ngrok hostport', function () {
  const parse_ngrok_hostport = ngrok_service.__get__('parse_ngrok_hostport');
  var test_endpoint = [{
    hostport: '8.tcp.ngrok.io:17632'
  }];
  var result_opts = parse_ngrok_hostport(test_endpoint, opts);
  it('host should match 8.tcp.ngrok.io', function () {
    assert.equal(result_opts.host, '8.tcp.ngrok.io');
  });
  it('port should match 17632', function () {
    assert.equal(result_opts.port, '17632');
  });
  it('host, port should be obtained from api', ()=> {
    get_hostport(opts).then((result) => {
      assert(result.host,'host should exist');
      assert(result.port,'port should exist');
    }, (err)=>{
      assert.equal(err,null);
    });

  });
});

/*
describe('ssh connection client ready', function () {
});

it('myEmitter should be enabled', function () {
  assert(myEmitter, 'received event emitter');
});

describe('ssh connection integration test', function () {

  it('ssh connect should invoke the ssh ready function', function (done) {
    this.timeout(10000);
    myEmitter.on('ssh_client_ready', (ssh_client) => {
      assert(ssh_client, 'ssh client created');
      done();
    });
  });
  var ws_socket = false;
  it('two websocket servers should be created', function (done) {
    this.timeout(18000);
    myEmitter.on('websocket_server_created', (socket) => {
      assert(socket, 'ssh websocket server created:' + socket.remotePort);
      if (!ws_socket) done();
      ws_socket = true;
    });
  });
  connect_ssh(opts);

});
*/


// test generate keypair
var test_generate_keypair = function () {
  const keypair = generate_keypair();
  console.log('keypair:');
  console.log(keypair.public_key);
  console.log(keypair.private_key);
  var homedir = os.homedir();
  var fname = path.join(homedir, '.ssh', 'zm_id_rsa.pub')
  //fs.writeFileSync(fname, keypair.public_key);
  fname = path.join(homedir, '.ssh', 'zm_id_rsa')
  //fs.writeFileSync(fname, keypair.private_key);
}
