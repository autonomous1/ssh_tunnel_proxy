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
const fs = require('fs');
const process = require('process');
const { Buffer } = require('node:buffer');
const { Client } = require('electron-ssh2');

const KeypairStorage = require('./keypair_storage');
const NgrokApi = require('./ngrok_service');

const keypairStorage = new KeypairStorage();

const homedir = require('os').homedir();

class SSHTunnelProxy extends Client {

    constructor() {
        super();
        this.listener = {};
        this.retries = 0;
        this.debug_en = false;
        this.debug_ssh = false;
        this._tunnelReadyTimeout = undefined;
    }

    // function to close all active sockets for tunnel restart and exception handling
    close_sockets(proxy_ports) {

        if (!proxy_ports) return;

        proxy_ports.forEach(proxy_port => {
            const server = this.listener[proxy_port];
            if (server && server.listening) {
                this.debug_en && this.debug('SSH Server :: closing forward:', proxy_port)
                server.close();
                delete this.listener[proxy_port];
            }
        });
    }

    // create forward out on socket connection
    setup_ssh_forward(socket, remote_hostname, remote_port) {
        const _this = this;

        // setup stream pipeline when port forward is ready
        const on_setup_ssh_forward = (err, stream) => {

            if (err) {
                _this.emit('debug', err);
                _this.debug_en && _this.debug('socket forward error:', err);
                return;
            }

            stream.on('end', () => {
                socket.resume();
            });

            // pipe the data from the local socket to the remote port and visa versa
            stream.pipe(socket).pipe(stream);

            const shutdown_forward = () => {
                stream.unpipe(socket);
                socket.unpipe(stream);
                stream.end();
            }

            // if socket ends, close stream and pipes
            socket.on('close', () => {
                shutdown_forward();
            });

            // if socket error, emit error and close stream
            socket.on('error', (err) => {
                _this.emit('debug', err);
                _this.debug_en && _this.debug('socket on error:', err);
                shutdown_forward();
            });
        }

        // create port forward
        _this.forwardOut(
            socket.remoteAddress,
            socket.remotePort,
            remote_hostname,
            remote_port,
            on_setup_ssh_forward
        );

    }

    // function to setup proxy forwards for ssh tunnel
    setupProxyPorts(proxy_ports) {

        return new Promise((resolve, reject) => {

            if (!proxy_ports) {
                resolve();
                return;
            }

            var listeners = 0;
            this.listener.isConnected = true;
            const _this = this;

            // iterate through a list of local forward ports and create a local proxy port
            proxy_ports.forEach(proxy_port => {

                const [local_port, remote_hostname, remote_port] = proxy_port.split(':');

                // create local socket server
                const server = _this.listener[proxy_port];
                if (server && server.listening) {
                    _this.debug_en && this.debug('SSH Server :: closing forward 2:', proxy_port)
                    server.close();
                }
                _this.listener[proxy_port] = net.createServer({ keepAlive: true, allowHalfOpen: false }, socket => {

                    if (this.debug_en) {
                        var debug_msg = 'SSH Server :: connection on ' + local_port + ' ' + socket.remotePort;
                        _this.emit('debug', debug_msg);
                        _this.debug(debug_msg);
                    }

                    // create a proxy forward between local and remote ports
                    _this.setup_ssh_forward(socket, remote_hostname, remote_port);
                });

                // start listening on port
                try {
                    var status_msg = 'SSH Server :: before listen on ' + local_port;
                    _this.emit('debug', status_msg);
                    _this.listener[proxy_port].listen(local_port, () => {

                        // emit server listening on port message
                        var status_msg = 'SSH Server :: bound on ' + local_port;
                        _this.emit('debug', status_msg);

                        // if all listeners have been successfully established, resolve setup connection
                        if (listeners++ >= proxy_ports.length - 1) {
                            _this.emit('ssh_tunnel_ready', {});
                            if (_this._tunnelReadyTimeout) {
                                clearTimeout(this._tunnelReadyTimeout);
                                _this._tunnelReadyTimeout = undefined;
                            }
                            resolve();
                        }
                    });
                } catch (err) {
                    _this.debug_en && _this.debug('listen err:', err);
                    reject(err);
                }
            });
        });
    }

    execCmd(cmd, dataStream, errStream) {

        return new Promise((resolve, reject) => {
            var bufs = [];
            var errs = [];

            const remote_exec = (err, stream) => {
                if (err) {
                    reject(err);
                    return;
                }

                const onClose = () => {
                    var buf = Buffer.concat(bufs);
                    var err = Buffer.concat(errs);
                    stream.removeListener('close', onClose);
                    resolve(buf, err);
                }
                stream.on('close', onClose);

                stream.on('data', (data) => {
                    if (dataStream) dataStream.write(data);
                    else bufs.push(data);
                })

                stream.stderr.on('data', (data) => {
                    if (errStream) errStream.write(data);
                    else errs.push(data);
                });

            }
            this.exec(cmd, remote_exec);
        })
    }

    // handle remote shell stream processing
    remote_shell(err, stream) {
        const _this = this;
        if (err) throw err;

        // disable local echo of input chars, use remote output only
        process.stdin.setRawMode(true);

        // forward data from local terminal to remote host
        const stdinListener = (data) => {
            stream.stdin.write(data);
        };

        // shutdown this process when stream ends (user logs out)
        stream.on('close', function () {
            process.stdin.setRawMode(false);
            process.stdin.removeListener("data", stdinListener);
            process.exit();
        }).stderr.on('data', function (data) {
            _this.debug_en && _this.debug('shell' + data);
        });

        // skip next stops double printing of input
        stream.stdout.on("data", (data) => {
            process.stdout.write(data);
        })
        process.stdin.on("data", stdinListener)
    }

    // handle setting up ssh client and proxy forward ports
    do_ssh_connect(opts) {

        const _this = this;

        // create a new ssh client connection with supplied credentials and hostname/port
        return new Promise((resolve) => {

            // exit if connection already established, avoid redundant connection on retry
            if (_this.listener.isConnected) resolve();

            // close open sockets on server, otherwise initialize open sockets storage
            _this.close_sockets(opts.proxy_ports);

            _this.on('ready', async () => {

                // stop any pending retry timeouts
                if (_this._tunnelReadyTimeout) {
                    clearTimeout(this._tunnelReadyTimeout);
                    _this._tunnelReadyTimeout = undefined;
                }

                // if local forwarding requested, setup local forwarding ports to remote host
                if (opts.proxy_ports) {
                    await _this.setupProxyPorts(opts.proxy_ports);
                }

                // if shell requested, enable remote terminal
                if (opts.shell) {
                    _this.shell(_this.remote_shell);

                    // otherwise, if exec requested, exec series of cmds
                } else {
                    if (opts.exec && opts.exec.length > 0) {
                        for (var i = 0; i < opts.exec.length; i++) {
                            var cmd = opts.exec[i];
                            _this.debug_en && _this.debug(opts.username + '@' + opts.hostname + ':' + cmd);
                            var result = await _this.execCmd(cmd);
                            _this.debug_en && _this.debug(result.toString());
                        }
                        process.exit();
                    }
                }

                resolve();
            });

            _this.on('end', () => {
                _this.debug_en && _this.debug('SSH Client :: end');
                _this.close_sockets(opts.proxy_ports);
            });

            _this.on('close', () => {
                _this.debug_en && _this.debug('SSH Client :: close');
                _this.close_sockets(opts.proxy_ports);
            });

            _this.on('error', err => {
                _this.debug_en && _this.debug('SSH Client :: error :: ' + err);
                _this.emit('debug', err);
                _this.listener.isConnected = false;
                if (_this._tunnelReadyTimeout) {
                    clearTimeout(this._tunnelReadyTimeout.elReadyTimeout);
                    _this._tunnelReadyTimeout = undefined;
                }
                _this.ssh_retry_connect(opts);
                resolve();
            });

            _this.on('handshake', negotiated => {
                _this.debug_en && _this.debug('SSH Client :: handshake:', JSON.stringify(negotiated));
            });

            _this.on('greeting', (message) => {
                _this.debug_en && _this.debug('SSH Client :: greeting:', message);
            });

            // create deep copy of opts as connect options
            const config = JSON.parse(JSON.stringify(opts));

            // add default ssh2 config options
            config.debug = (this.debug_ssh) ? (...args) => { console.log(...args); } : null;
            config.keepaliveInterval = opts.keepaliveInterval || 10000;

            // remove ssh_tunnel_proxy config extensions
            const ssh_tunnel_extensions = ['alias', 'disabled', 'hostname', 'ngrok_api', 'server_name', 'service_name', 'whitelist', 'private_key_filename'];
            for (var i = 0; i < ssh_tunnel_extensions.length; i++) delete config[ssh_tunnel_extensions[i]];

            // connect to remote host
            _this.connect(config);
        });
    }

    // validate port number - check for nan, out of valid port range, unauthorized system ports
    validate_port_number(port_str, whitelist) {
        if (isNaN(port_str)) return false;
        const port = parseInt(port_str);
        if (port < 1 || port > 65535) return false;
        if (port < 1024 && whitelist && whitelist[port] === undefined) return false;
        return true;
    }

    // validate local forwards for correct format and valid ports
    validate_local_forward(proxy_ports, whitelist) {

        if (!proxy_ports) return;

        const local_ports = [];
        const remote_ports = [];
        proxy_ports.forEach(proxy_port => {
            const [local_port, remote_hostname, remote_port] = proxy_port.split(':');
            if (remote_hostname.length < 1) remote_ports.push(remote_port);
            if (!this.validate_port_number(local_port, whitelist)) local_ports.push(local_port);
            if (!this.validate_port_number(remote_port, whitelist)) remote_ports.push(remote_port);
        });
        if (local_ports.length || remote_ports.length) {
            const err = new Error('Invalid local forward');

            this.debug_en && this.debug('invalid ports found:\n', JSON.stringify(proxy_ports, null, 2),
                '\n', JSON.stringify(whitelist, null, 2));

            err.info = {
                local_ports: local_ports.join(','),
                remote_ports: remote_ports.join(',')
            };
            throw (err);
        }
        return true;
    }

    // on network error, attempt to re-establish connection until 10 retries
    //clearTimeout(this._readyTimeout);
    ssh_retry_connect(opts) {
        const _this = this;
        const invoke = () => {
            _this.connectSSH(opts);
        }
        if (this.retries++ < 10) this._tunnelReadyTimeout = setTimeout(invoke, 5000);
    }

    // attempt to establish ssh tunnel to server with supplied parameters.
    async ssh_start_tunnel(opts) {
        const _this = this;
        async function do_ssh_connect(resolve) {

            // after successful tunnel setup complete, send events and reset retry counter
            await _this.do_ssh_connect(opts).then(() => {
                const hostport = opts.host + ':' + opts.port;
                if (_this.debug_en) {
                    const msg = 'SSH connection to ' + opts.server_name + ' established at ' + hostport;
                    _this.debug(msg);
                }
                //_this.emit('status', '', 'ready', hostport);
                _this.retries = 0;
                resolve();
            });
        }
        return new Promise(do_ssh_connect);
    }

    // setup ssh connection parameters and attempt to establish ssh tunnel
    // todo: if opts have changed while service is running, shutdown current service and restart with new opts
    async connectSSH(opts, whitelist) {

        // make deep copy of opts for modification
        var _opts = JSON.parse(JSON.stringify(opts));

        // setup whitelist from param or opts in case of error retry
        _opts.whitelist = (whitelist !== undefined) ? whitelist : (_opts.whitelist) ? _opts.whitelist : null;

        // validate local port forwards, emit error and quit if invalid
        try {
            this.validate_local_forward(_opts.proxy_ports, _opts.whitelist);
        } catch (err) {
            this.emit('debug', err);
            this.debug_en && this.debug(err);
            return err;
        }

        // if password is empty set to undefined
        if (opts.password && !opts.password.length) {
            _opts.password = undefined;
        }

        if (_opts.private_key_filename) {
            try {
                if (_opts.private_key_filename[0] == '~') {
                    _opts.private_key_filename = homedir + _opts.private_key_filename.substr(1);
                }
                _opts.privateKey = fs.readFileSync(_opts.private_key_filename).toString();
            } catch (err) {
                console.log('Error loading key:', err);
            }
        }

        // retrieve private key from system keychain with supplied service name and server
        // if no key found, authentication is supplied username, password
        if (_opts.service_name && _opts.server_name) {
            _opts.privateKey = await keypairStorage.get_keypair(opts.service_name, opts.server_name);
        } else {
            if (!_opts.server_name) _opts.server_name = 'sshtun';
        }

        // if ngrok api key provided, obtain hostname and hostport from ngrok api
        // if no ngrok tunnel specified, use supplied host and port
        if (_opts.ngrok_api) {
            const _this = this;
            const ngrokApi = new NgrokApi(_opts.ngrok_api);
            var hostport = await ngrokApi.get_hostport()
                .catch(() => {
                    _this.debug_en && _this.debug('ngrok get_hostport connection error');
                    _this.listener.isConnected = false;
                    _this.ssh_retry_connect(_opts);
                });
            if (hostport && hostport.host) {
                _opts.host = hostport.host;
                _opts.port = hostport.port;
            }
            else return null;
        }

        this.debug_en && this.debug('connectSSH:\n', JSON.stringify(_opts, null, 2));

        // initiate ssh tunnel, block until tunnel is established or error
        return await this.ssh_start_tunnel(_opts)
            .catch((err) => {
                this.debug_en && this.debug('ssh_start_tunnel catch:' + err);
            });
    }

    // resume connection, if previously online
    onNetworkOnline() { }

    // connection down, shutdown tunnel
    onNetworkOffline() { }

    generateAndStoreKeypair(...args) {
        keypairStorage.generate_and_store_keypair(...args);
    }

    getPublicKey(...args) {
        keypairStorage.get_public_key_from_keychain(...args);
    }

    debug(...args) { console.log(...args); }

}

module.exports = {
    SSHTunnelProxy: SSHTunnelProxy,
    KeypairStorage: KeypairStorage,
    NgrokApi: NgrokApi
}
