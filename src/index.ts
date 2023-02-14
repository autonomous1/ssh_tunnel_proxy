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

import { Server, Socket, createServer } from 'net';
import { readFileSync } from 'fs';
import { Writable } from 'stream';
import { stdin, stdout, stderr, exit } from 'process';
import { EventEmitter } from 'events';
import { Client, Channel } from 'electron-ssh2';
import { KeypairStorage } from './keypair_storage';
import { NgrokApi, Hostport } from './ngrok_service';
import { main } from './ssh2-node';
import { homedir } from 'os';

interface Listener {
  [key: string]: Server;
}

export type SSHConfig = {
  hostname: string;
  username: string;
  password?: string;
  host?: string;
  port?: string;
  proxy_ports?: Array<string>;
  remote_ports?: Array<string>;
  private_key?: string | null;
  private_key_filename?: string | null;
  disabled?: boolean;
  server_name?: string;
  service_name?: string;
  compress?: string;
  cypher?: string;
  exec?: Array<string>;
  shell?: boolean;
  ngrok_api?: string;
  keepaliveInterval?: number;
};

export class SSHTunnelProxy extends EventEmitter {
  protected client: Client;
  protected keypairStorage: KeypairStorage;
  protected config: SSHConfig;
  protected listener: Listener;
  protected retries: number;
  protected networkOnline: boolean;
  protected _tunnelReadyTimeout: ReturnType<typeof setTimeout>;
  public debug_en: boolean;
  public debug_ssh: boolean;

  constructor() {
    super();
    this.listener = <Listener>{};
    this.retries = 0;
    this.debug_en = false;
    this.debug_ssh = false;
    this._tunnelReadyTimeout = undefined;
    this.networkOnline = false;
    this.config = null;
    this.client = new Client();
    this.keypairStorage = new KeypairStorage();
  }

  // function to close all active sockets for tunnel restart and exception handling
  protected close_sockets(proxy_ports: Array<string>) {
    if (!proxy_ports) return;

    proxy_ports.forEach((proxy_port) => {
      const server = this.listener[proxy_port];
      if (server && server.listening) {
        this.debug_en && this.debug('SSH Server :: closing forward:', proxy_port);
        server.close();
        delete this.listener[proxy_port];
      }
    });
  }

  // create forward out on socket connection
  protected setup_ssh_forward(socket: Socket, remote_hostname: string, remote_port: string) {

    // setup stream pipeline when port forward is ready
    const on_setup_ssh_forward = (err: Error, stream: Channel) => {
      if (err) {
        this.emit('debug', err);
        this.debug_en && this.debug('socket forward error:', err);
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
      };

      // if socket ends, close stream and pipes
      socket.on('close', () => {
        shutdown_forward();
      });

      // if socket error, emit error and close stream
      socket.on('error', (err: Error) => {
        this.emit('debug', err);
        this.debug_en && this.debug('socket on error:', err);
        shutdown_forward();
      });
    };

    // create port forward
    this.client.forwardOut(
      socket.remoteAddress,
      socket.remotePort,
      remote_hostname,
      remote_port,
      on_setup_ssh_forward,
    );
  }

  // function to setup proxy forwards for ssh tunnel
  public setupProxyPorts(proxy_ports: Array<string>) {
    return new Promise<void>((resolve, reject) => {
      if (!proxy_ports) {
        resolve();
        return;
      }

      let listeners = 0;

      // iterate through a list of local forward ports and create a local proxy port
      proxy_ports.forEach((proxy_port) => {
        const [local_port, remote_hostname, remote_port] = proxy_port.split(':');

        // create local socket server
        const server = this.listener[proxy_port];
        if (server && server.listening) {
          this.debug_en && this.debug('SSH Server :: closing forward 2:', proxy_port);
          server.close();
        }
        this.listener[proxy_port] = createServer({ allowHalfOpen: false }, (socket) => {
          if (this.debug_en) {
            const debug_msg = 'SSH Server :: connection on ' + local_port + ' ' + socket.remotePort;
            this.emit('debug', debug_msg);
            this.debug(debug_msg);
          }

          // create a proxy forward between local and remote ports
          this.setup_ssh_forward(socket, remote_hostname, remote_port);
        });

        // start listening on port
        try {
          const status_msg = 'SSH Server :: before listen on ' + local_port;
          this.emit('debug', status_msg);
          this.listener[proxy_port].listen(local_port, () => {
            // emit server listening on port message
            const status_msg = 'SSH Server :: bound on ' + local_port;
            this.emit('debug', status_msg);

            // if all listeners have been successfully established, resolve setup connection
            if (listeners++ >= proxy_ports.length - 1) {
              this.emit('ssh_tunnel_ready', {});
              if (this._tunnelReadyTimeout) {
                clearTimeout(this._tunnelReadyTimeout);
                this._tunnelReadyTimeout = undefined;
              }
              resolve();
            }
          });
        } catch (err) {
          this.debug_en && this.debug('listen err:', err);
          reject(err);
        }
      });
    });
  }

  // execute remote command, optionally stream result and errors
  public execCmd(cmd: string, dataStream?: Writable, errStream?: Writable) {
    return new Promise<void>((resolve, reject) => {
      const remote_exec = (err: Error, stream: Channel) => {
        if (err) {
          reject(err);
          return;
        }

        const onClose = () => {
          stream.removeListener('close', onClose);
          resolve();
        };
        stream.on('close', onClose);

        stream.on('data', (data) => {
          if (dataStream) dataStream.write(data);
          else stdout.write(data);
        });

        stream.stderr.on('data', (data) => {
          if (errStream) errStream.write(data);
          else stderr.write(data);
        });
      };
      this.client.exec(cmd, remote_exec);
    });
  }

  // handle remote shell stream processing
  protected remote_shell(err: Error, stream: Channel) {
    if (err) throw err;

    // disable local echo of input chars, use remote output only
    stdin.setRawMode(true);
    //stream.stdout.write('stty -echo\n');

    // forward data from local terminal to remote host
    const stdinData = (data) => {
      stream.stdin.write(data);
    };
    stdin.on('data', stdinData);

    const stdoutData = (data) => {
      stdout.write(data);
    };
    stream.stdout.on('data', stdoutData);

    // shutdown this process when stream ends (user logs out)
    stream
      .on('close', () => {
        stdin.setRawMode(false);
        stdin.removeListener('data', stdinData);
        stream.stdout.removeListener('data', stdoutData);
        exit();
      })
      .stderr.on('data', (data) => {
        this.debug_en && this.debug('shell' + data);
      });
  }

  // remove ssh client event listeners
  protected cleanup_events(client: Client) {
    const eventNames = ['close', 'end', 'error', 'greeting', 'handshake', 'ready'];
    for (let j = 0; j < eventNames.length; j++) {
      const eventName = eventNames[j];
      const events = client._events[eventName];
      if (events) {
        if (events instanceof Array) {
          for (let i = 0; i < events.length; i++) {
            client.removeListener(eventName, events[i]);
          }
        }
        if (events instanceof Function) {
          client.removeListener(eventName, events);
        }
      }
    }
  }

  // handle setting up ssh client and proxy forward ports
  public do_ssh_connect(opts: SSHConfig) {
    const _client = this.client;

    // create a new ssh client connection with supplied credentials and hostname/port
    return new Promise<void>((resolve) => {
      // close open sockets on server, otherwise initialize open sockets storage
      this.close_sockets(opts.proxy_ports);

      // remove existing event listeners, if any
      this.cleanup_events(_client);

      _client.on('ready', async () => {
        // stop any pending retry timeouts
        if (this._tunnelReadyTimeout) {
          clearTimeout(this._tunnelReadyTimeout);
          delete this._tunnelReadyTimeout;
        }

        // if local forwarding requested, setup local forwarding ports to remote host
        if (opts.proxy_ports) {
          await this.setupProxyPorts(opts.proxy_ports);
        }

        // if shell requested, enable remote terminal
        if (opts.shell) {
          //const channel = await _this.nodeSSH.requestShell();
          this.client.shell(this.remote_shell);

          // otherwise, if exec requested, exec series of cmds
        } else {
          if (opts.exec && opts.exec.length > 0) {
            for (let i = 0; i < opts.exec.length; i++) {
              const cmd = opts.exec[i];
              this.debug_en && this.debug(opts.username + '@' + opts.hostname + ':' + cmd);
              await this.execCmd(cmd);
            }
          }
        }

        resolve();
      });

      _client.on('end', () => {
        this.debug_en && this.debug('SSH Client :: end');
        this.close_sockets(opts.proxy_ports);
      });

      _client.on('close', () => {
        this.debug_en && this.debug('SSH Client :: close');
        this.close_sockets(opts.proxy_ports);
      });

      _client.on('error', (err: Error) => {
        this.debug_en && this.debug('SSH Client :: error :: ' + err);
        this.emit('debug', err);
        if (this._tunnelReadyTimeout) {
          clearTimeout(this._tunnelReadyTimeout);
          this._tunnelReadyTimeout = undefined;
        }
        this.ssh_retry_connect(opts);
        resolve();
      });

      // create deep copy of opts as connect options
      const config = JSON.parse(JSON.stringify(opts));

      // add default ssh2 config options
      config.debug = this.debug_ssh
        ? (...args) => {
            console.log(...args);
          }
        : null;
      config.keepaliveInterval = opts.keepaliveInterval || 10000;

      // remove ssh_tunnel_proxy config extensions
      const ssh_tunnel_extensions = [
        'alias',
        'disabled',
        'hostname',
        'ngrok_api',
        'server_name',
        'service_name',
        'whitelist',
        'private_key_filename',
      ];
      for (let i = 0; i < ssh_tunnel_extensions.length; i++) delete config[ssh_tunnel_extensions[i]];
      // connect to remote host
      _client.connect(config);
    });
  }

  // validate port number - check for nan, out of valid port range, unauthorized system ports
  public validate_port_number(port: number, whitelist: object) {
    if (isNaN(port)) return false;
    if (port < 1 || port > 65535) return false;
    if (port < 1024 && whitelist && whitelist[port] === undefined) return false;
    return true;
  }

  // validate local forwards for correct format and valid ports
  public validate_local_forward(proxy_ports: Array<string>, whitelist: object) {
    if (!proxy_ports) return;

    const local_ports = [];
    const remote_ports = [];
    proxy_ports.forEach((proxy_port: string) => {
      const [local_port, remote_hostname, remote_port] = proxy_port.split(':');
      const ilocal_port: number = parseInt(local_port);
      const iremote_port: number = parseInt(remote_port);
      if (remote_hostname.length < 1) remote_ports.push(remote_port);
      if (!this.validate_port_number(ilocal_port, whitelist)) local_ports.push(local_port);
      if (!this.validate_port_number(iremote_port, whitelist)) remote_ports.push(remote_port);
    });
    if (local_ports.length || remote_ports.length) {
      const err = new Error('Invalid local forward');
      this.debug_en &&
        this.debug(
          'invalid ports found:\n',
          JSON.stringify(proxy_ports, null, 2),
          '\n',
          JSON.stringify(whitelist, null, 2),
        );
      throw err;
    }
    return true;
  }

  // on network error, attempt to re-establish connection until 10 retries
  //clearTimeout(this._readyTimeout);
  protected ssh_retry_connect(opts: SSHConfig) {
    const invoke = () => {
      this.connectSSH(opts, null);
    };
    if (this.retries++ < 10) this._tunnelReadyTimeout = setTimeout(invoke, 5000);
  }

  // attempt to establish ssh tunnel to server with supplied parameters.
  protected async ssh_start_tunnel(opts: SSHConfig) {
    const do_ssh_connect = async (resolve)=> {
      // after successful tunnel setup complete, send events and reset retry counter
      await this.do_ssh_connect(opts).then(() => {
        const hostport = opts.host + ':' + opts.port;
        if (this.debug_en) {
          const msg = 'SSH connection to ' + opts.server_name + ' established at ' + hostport;
          this.debug(msg);
        }
        this.emit('status', '', 'ready', hostport);
        this.retries = 0;
        resolve();
      });
    }
    return new Promise(do_ssh_connect);
  }

  // setup ssh connection parameters and attempt to establish ssh tunnel
  // todo: if opts have changed while service is running, shutdown current service and restart with new opts
  public async connectSSH(opts: SSHConfig, whitelist: object | null) {
    // make deep copy of opts for modification
    const _opts = JSON.parse(JSON.stringify(opts));

    // setup whitelist from param or opts in case of error retry
    _opts.whitelist = whitelist !== undefined ? whitelist : _opts.whitelist ? _opts.whitelist : null;

    // validate local port forwards, emit error and quit if invalid
    try {
      this.validate_local_forward(_opts.proxy_ports, _opts.whitelist);
    } catch (err) {
      this.emit('debug', err);
      this.debug_en && this.debug(err);
      throw(err);
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
        _opts.privateKey = readFileSync(_opts.private_key_filename).toString();
      } catch (err) {
        console.log('Error loading key:', err);
        throw(err);
      }
    }

    // retrieve private key from system keychain with supplied service name and server
    // if no key found, authentication is supplied username, password
    if (_opts.service_name && _opts.server_name) {
      _opts.privateKey = await this.keypairStorage.get_keypair(opts.service_name, opts.server_name);
    } else {
      if (!_opts.server_name) _opts.server_name = 'sshtun';
    }

    // if ngrok api key provided, obtain hostname and hostport from ngrok api
    // if no ngrok tunnel specified, use supplied host and port
    if (_opts.ngrok_api) {
      const ngrokApi = new NgrokApi(_opts.ngrok_api);
      const hostport = <Hostport>await ngrokApi.get_hostport().catch(() => {
        this.debug_en && this.debug('ngrok get_hostport connection error');
        this.ssh_retry_connect(_opts);
      });
      if (hostport && hostport.host) {
        _opts.host = hostport.host;
        _opts.port = hostport.port;
      } else {
        const err = new Error('invalid hostport obtained from ngrok api');
        throw(err);
      }
    }

    this.debug_en && this.debug('connectSSH.ts:\n', JSON.stringify(_opts, null, 2));

    // initiate ssh tunnel, block until tunnel is established or error
    await this.ssh_start_tunnel(_opts).catch((err) => {
      this.debug_en && this.debug('ssh_start_tunnel catch:' + err);
    });
  }

  // resume connection, if previously online
  public onNetworkOnline() {
    this.networkOnline = true;
  }

  // connection down, shutdown tunnel
  public onNetworkOffline() {
    this.networkOnline = false;
  }

  public generateAndStoreKeypair(serviceName: string, account: string) {
    this.keypairStorage.generate_and_store_keypair(serviceName, account);
  }

  public getPublicKey(serviceName: string, account: string) {
    this.keypairStorage.get_public_key_from_keychain(serviceName, account);
  }

  public getClient() {
    return this.client;
  }

  protected debug(...args) {
    console.log(...args);
  }
}

export { KeypairStorage, NgrokApi, main as sshcli };