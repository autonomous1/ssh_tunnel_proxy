/*

ssh_tunnel_proxy - initiate a ssh reverse tunnel proxy with forwarding ports
with connection optional ssh tunnel service ngrok

ssh_tunnel_proxy can function as a stand-alone api or part of an electron_js app. To establish a ssh tunnel proxy a keypair is generated on the client and stored in the system keychain.
If a ngrok api key is provided the ngrok api endpoint method is invoked to obtain the hostport of
the tunnel. A list of port forwards is provided to the connect_api function and ports validated to
restrict connections to system ports on the remote host to a set of pre-defined ports such as http,https.
After establishing a ssh connection to the remote server, local proxy port forwards are opened. If
the connection is interrupted then the ssh_connect method will attempt to re-establish the connection.

Author: Autonomous
First release: 1-29-2023
License: MIT

*/

const net = require('net');
const { EventEmitter } = require('node:events');
const { Client } = require('electron-ssh2');

const keypair_storage = require('./keypair_storage');
const { get_hostport } = require('./ngrok_service');

// emit events to enable hooks to be established during tunnel setup and error handling
class SSHEmitter extends EventEmitter { };
const sshEmitter = new SSHEmitter();

// debugging options
const debug = false;
const debug_ssh = false;

// storage for all open sockets on each server
var listener = {};

// function to close all active sockets for tunnel restart and exception handling
const close_sockets = (server_name, proxy_ports) => {
    if (!listener[server_name]) return;
    proxy_ports.forEach(proxy_port => {
        const server = listener[server_name][proxy_port];
        if (server && server.listening) {
            if (debug) console.log('closing server:', proxy_port)
            server.close();
        }
    });
}

// ssh client debug function for verbose ssh connection details
const debug_client = (debug_ssh) ? (msg) => { console.log(msg); } : null;

// function to handle setting up tunnel and proxy forward ports
const do_ssh_connect = (opts) => {

    // close open sockets on server, otherwise initialize open sockets storage
    if (listener[opts.server_name]) {
        close_sockets(opts.server_name, opts.proxy_ports);
    } else {
        listener[opts.server_name] = {};
    }

    // create a new ssh client connection with supplied credentials and hostname/port
    return new Promise((resolve, reject) => {

        var listeners = 0;
        const ssh_client = new Client();

        // setup ssh client event listeners
        ssh_client.on('end', () => {
            if (debug) console.log('SSH Client :: end');
            close_sockets(opts.server_name, opts.proxy_ports);
        });
        ssh_client.on('close', () => {
            if (debug) console.log('SSH Client :: close');
            close_sockets(opts.server_name, opts.proxy_ports);
        });
        ssh_client.on('error', err => {
            if (debug) console.log('SSH Client :: error :: ' + err);
            sshEmitter.emit('error', err);
            close_sockets(opts.server_name, opts.proxy_ports);
            ssh_retry_connect(opts);
            resolve();
        });
        ssh_client.on('handshake', negotiated => {
            if (debug) console.log('SSH Client :: handshake:', JSON.stringify(negotiated));
        });
        ssh_client.on('banner', (message, language) => {
            if (debug) console.log('SSH Client :: banner:', message);
        });

        // when ssh client is ready, establish proxy forward ports to remote server
        ssh_client.on('ready', () => {

            // iterate through a list of local forward ports and create a local proxy port
            opts.proxy_ports.forEach(proxy_port => {
                const [local_port, remote_hostname, remote_port] = proxy_port.split(':');

                // create local websocket server
                listener[opts.server_name][proxy_port] = net.createServer({ keepAlive: true, allowHalfOpen: false }, socket => {

                    if (debug) {
                        var debug_msg = 'SSH Server :: connection on ' + local_port + ' ' + socket.remotePort;
                        sshEmitter.emit('debug', debug_msg);
                        console.log(debug_msg);
                    }

                    // create a proxy forward between the local port and remote port
                    ssh_client.forwardOut(
                        socket.remoteAddress,
                        socket.remotePort,
                        remote_hostname,
                        remote_port,
                        (err, stream) => {
                            if (err) {
                                sshEmitter.emit('error', err);
                                if (debug) console.log('socket forward error:', err);
                                //reject(err);
                                return;
                            }

                            // pipe the data from the local socket to the remote port and visa versa
                            socket.pipe(stream);
                            stream.pipe(socket);

                            // if socket ends, close stream and pipes
                            socket.on('close', () => {
                                stream.end();
                            });

                            // if socket error, emit error and close stream
                            socket.on('error', (err) => {
                                sshEmitter.emit('error', err);
                                if (debug) console.log('socket on error:', err);
                                stream.end();
                            });

                        }
                    );
                })

                // start listening on port
                listener[opts.server_name][proxy_port].listen(local_port, () => {

                    // emit server listening on port message
                    var status_msg = 'SSH Server :: bound on ' + local_port;
                    sshEmitter.emit('status', status_msg, 'listening', local_port);

                    // if all listeners have been successfully established, resolve setup connection
                    if (listeners++ >= opts.proxy_ports.length - 1) {
                        resolve();
                    }
                });
            });
        });

        // initiate ssh client connection to remote host
        ssh_client.connect({
            host: opts.host,
            port: opts.port,
            username: opts.username,
            password: opts.password,
            privateKey: opts.private_key,
            debug: debug_client,
            keepaliveInterval: 10000
        });
    });
}

// validate port number - check for nan, out of valid port range, unauthorized system ports
const validate_port_number = function (port_str, whitelist) {
    if (isNaN(port_str)) return false;
    const port = parseInt(port_str);
    if (port < 1 || port > 65535) return false;
    if (port < 1024 && whitelist[port] === undefined) return false;
    return true;
}

// validate local forwards for correct format and valid ports
const validate_local_forward = function (proxy_ports, whitelist) {
    const local_ports = [];
    const remote_ports = [];
    proxy_ports.forEach(proxy_port => {
        const [local_port, remote_hostname, remote_port] = proxy_port.split(':');
        if (!validate_port_number(local_port, whitelist)) local_ports.push(local_port);
        if (!validate_port_number(remote_port, whitelist)) remote_ports.push(remote_port);
    });
    if (local_ports.length || remote_ports.length) {
        const err = new Error('Invalid local forward');
        err.info = {
            local_ports: local_ports.join(','),
            remote_ports: remote_ports.join(',')
        };
        throw (err);
    }
    return true;
}

// on network error, attempt to re-establish connection until 10 retries
let retries = 0;
const ssh_retry_connect = (opts) => {
    if (retries++ < 10) setTimeout(connect_ssh, 5000, opts);
}

// attempt to establish ssh tunnel to server with supplied parameters.
const ssh_start_tunnel = async (opts) => {
    return new Promise(async (resolve, reject) => {

        // after successful tunnel setup complete, send events and reset retry counter
        await do_ssh_connect(opts).then(() => {
            const hostport = opts.host + ':' + opts.port;
            const msg = 'SSH connection to ' + opts.server_name + ' established at ' + hostport;
            if (debug) console.log(msg);
            sshEmitter.emit('status', '', 'ready', hostport);
            retries = 0;
            resolve();
        }, (err) => {
            if (debug) console.log('ssh_retry error:', err);
            reject();
        });
    });
}

// export function to setup ssh connection parameters and attempt to establish ssh tunnel
// todo: if opts have changed while service is running, shutdown current service and restart with new opts
const connect_ssh = async function (opts, whitelist) {
    if (debug) {
        console.log('connect_ssh:');
        console.log(JSON.stringify(opts, null, 2));
    }

    // make deep copy of opts for modification
    var _opts = JSON.parse(JSON.stringify(opts));

    // setup whitelist from param or opts in case of error retry
    _opts.whitelist = (whitelist !== undefined) ? whitelist : (_opts.whitelist) ? _opts.whitelist : {};

    // validate local port forwards, emit error and quit if invalid
    try {
        validate_local_forward(_opts.proxy_ports, _opts.whitelist);
    } catch (err) {
        sshEmitter.emit('error', err);
        if (debug) console.log(err);
        return err;
    }

    // if password is empty set to undefined
    if (opts.password && !opts.password.length) {
        _opts.password = undefined;
    }

    // retrieve private key from system keychain with supplied service name and server
    // if no key found, authentication is supplied username, password
    _opts.private_key = await keypair_storage.retrieve_private_key(opts.service_name, opts.server_name);

    // if ngrok api key provided, obtain hostname and hostport from ngrok api
    // if no ngrok tunnel specified, use supplied host and port
    if (_opts.ngrok_api) {
        var hostport = await get_hostport(_opts.ngrok_api)
            .catch((err) => {
                if (debug) console.log('ngrok get_hostport connection error');
                ssh_retry_connect(opts);
            });
        if (hostport && hostport.host) {
            _opts.host = hostport.host;
            _opts.port = hostport.port;
        }
        else return null;
    }

    // initiate ssh tunnel, block until tunnel is established or error
    return await ssh_start_tunnel(_opts);
}

// export function to obtain ssh connection event emitter
const get_event_hook = () => { return sshEmitter; }

module.exports = {
    connect_ssh: connect_ssh,
    generate_and_store_keypair: keypair_storage.generate_and_store_keypair,
    generate_keypair: keypair_storage.generate_keypair,
    get_public_key: keypair_storage.get_public_key_from_keychain,
    remove_keypair: keypair_storage.remove_keypair,
    get_event_hook: get_event_hook
}
