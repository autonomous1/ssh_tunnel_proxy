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


type RemoteTCPConnection = {
  destIP: string,
  destPort: string,
  srcIP: string,
  srcPort: string
}

type RemoteAccept_fn = () => Channel;
type RemoteReject_fn = () => Error;
interface RemotePort {
  [key: string]: Socket;
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
  protected remote_port: RemotePort;
  protected retries: number;
  protected networkOnline: boolean;
  protected _tunnelReadyTimeout: ReturnType<typeof setTimeout>;
  public debug_en: boolean;
  public debug_ssh: boolean;

  constructor() {
    super();
    this.listener = <Listener>{};
    this.remote_port = <RemotePort>{};
    this.retries = 0;
    this.debug_en = false;
    this.debug_ssh = false;
    this._tunnelReadyTimeout = undefined;
    this.networkOnline = false;
    this.config = null;
    this.client = new Client();
    this.keypairStorage = new KeypairStorage();
  }

  protected shutdown_client(opts) {
    if (!this.client) return;
    this.close_sockets(opts.proxy_ports);
    this.close_remote_forwards(opts.remote_forwards);
  }

  // function to close all active sockets for tunnel restart and exception handling
  protected close_sockets(proxy_ports: Array<string>) {

    if (!proxy_ports) return;

    proxy_ports.forEach((proxy_port) => {
      const server = this.listener[proxy_port];
      if (server && server.listening) {
        this.debug_en && this.debug('SSH Server :: closing forward:', proxy_port);
        try {
          server.close();
        } catch (err) {
          this.debug_en && this.debug('error closing server:', err);
        } finally {
          delete this.listener[proxy_port];
        }
      }
    });
  }

  protected close_remote_forwards(remote_ports: Array<string>) {

    if (!remote_ports) return;

    remote_ports.forEach((remote_port) => {
      if (this.remote_port[remote_port]) {
        const [remote_addr, port_str] = remote_port.split(':');
        const port = parseInt(port_str);
        this.client.unforwardIn(remote_addr, port, this.remote_port[remote_port]);
        delete this.remote_port[remote_port];
      }
    });
  }

  // create forward out on socket connection
  protected setup_local_forward(socket: Socket, remote_hostname: string, remote_port: string) {

    // create port forward
    this.client.forwardOut(
      socket.remoteAddress,
      socket.remotePort,
      remote_hostname,
      remote_port,
      (err: Error, stream: Channel) => {  // Wrap callback in arrow function to capture err

        if (err) {
          this.debug_en && this.debug('local forward error:', err);
          return;
        }

        stream.on('end', () => {
          socket.resume();
        });

        // pipe the data from the local socket to the remote port and visa versa
        stream.pipe(socket).pipe(stream);

        // Define source of shutdown_forward() outside of try-catch block      
        let shutdown_forward: () => void;

        try {
          // Define source of shutdown_forward() inside of try-catch block
          shutdown_forward = () => {
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
            this.debug_en && this.debug('socket on error:', err);
            shutdown_forward();
          });

        } catch (err) {
          this.debug_en && this.debug('listen err:', err);
        }
      }
    );
  }

  protected async setup_remote_forward(remote_forward_str: string) {

    return new Promise<number>((resolve, reject) => {

      const remote_forward_ar: Array<string> = remote_forward_str.split(':');
      let bind_address = '';
      let local_port = 0;
      let host = '';
      let remote_port = 0;
      if (remote_forward_ar.length > 3) {
        bind_address = remote_forward_ar[0];
        local_port = parseInt(remote_forward_ar[1]);
        host = remote_forward_ar[2];
        remote_port = parseInt(remote_forward_ar[3]);
      } else if (remote_forward_ar.length > 2) {
        bind_address = 'localhost';
        local_port = parseInt(remote_forward_ar[0]);
        host = remote_forward_ar[1];
        remote_port = parseInt(remote_forward_ar[2]);
      } else {
        const err = new Error('invalid remote forward format:' + remote_port);
        reject(err);
        return null;
      }

      const fn_remote_port = (err: Error, port: number) => {
        if (err) {
          this.debug_en && this.debug('remote forward error:', err);
          reject(err);
          return;
        }
        const socket = new Socket();
        const socketid = bind_address + ':' + remote_port;
        this.remote_port[socketid] = socket;
        socket.on('ready', () => {
          resolve(port);
        })
        socket.on('error', (err) => {
          reject(err);
        })
        socket.connect({
          host: host,
          port: local_port,
          keepAlive: true
        });
      }
      this.client.forwardIn(bind_address, remote_port, fn_remote_port);
    });
  }

  // setupRemotePorts
  // on tcp connection, obtain forwarding server address and port, open client connection and write data to server
  public async setupRemotePorts(remote_ports: Array<string>) {
    return new Promise<void>((resolve, reject) => {

      if (!remote_ports) {
        resolve();
        return;
      }

      this.client.on('tcp connection', (details: RemoteTCPConnection, accept: RemoteAccept_fn, reject: RemoteReject_fn) => {

        this.debug_en && this.debug(JSON.stringify(details));

        const socketid = details.destIP + ':' + details.destPort;
        const socket = this.remote_port[socketid];
        if (!socket) {
          const errMsg = 'tcp connection: received unexpected remote forward:' + socketid;
          this.debug_en && this.debug(errMsg);
          reject();
          return;
        }
        const channel = accept();
        channel.pipe(socket).pipe(channel);

        try {
          const shutdown_forward = () => {
            channel.unpipe(socket);
            socket.unpipe(channel);
            channel.end();
          };
          channel.on('close', () => {
            shutdown_forward()
          });
          channel.on('error', (err: Error) => {
            shutdown_forward()
            this.debug_en && this.debug('remote forward error:' + err.toString());
            reject();
          });
        } catch (err) {
          this.debug_en && this.debug('remote forward error:' + err.toString());
          reject();
        }

      });

      for (let i = 0; i < remote_ports.length; i++) {
        this.setup_remote_forward(remote_ports[i])
          .then(() => {
            if (i === remote_ports.length - 1) resolve();
          })
          .catch((err) => {
            reject(err);
            return false;
          });
      }
    });
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
        const [local_port_str, remote_hostname, remote_port] = proxy_port.split(':');
        const local_port = parseInt(local_port_str);

        // if server already in use, close
        let server = this.listener[proxy_port];
        if (server && server.listening) {
          this.debug_en && this.debug('SSH Server :: closing forward 2:', proxy_port);
          server.close();
        }

        // create local socket server
        server = createServer({ allowHalfOpen: false }, (socket) => {

          if (this.debug_en) {
            const debug_msg = 'SSH Server :: connection on ' + local_port + ' ' + socket.remotePort;
            this.debug(debug_msg);
          }

          // create a proxy forward between local and remote ports
          this.setup_local_forward(socket, remote_hostname, remote_port);
        });

        this.listener[proxy_port] = server;

        // handle any server errors here
        server.on('error', (err) => {
          this.debug_en && this.debug('listen err:', err);
          this.emit('error', err);
          reject(err);
        });

        // start listening on port
        server.listen(local_port, () => {
          // emit server listening on port message
          const status_msg = 'SSH Server :: bound on ' + local_port;
          this.debug_en && this.debug(status_msg);

          // if all listeners have been successfully established, resolve setup connection
          if (listeners++ >= proxy_ports.length - 1) {
            this.emit('ssh_tunnel_ready', {});
            if (this._tunnelReadyTimeout) {
              clearTimeout(this._tunnelReadyTimeout);
              this._tunnelReadyTimeout = undefined;
            }
            resolve();
          }
        }
        );
      });
    });
  }

  // execute remote command, optionally stream result and errors
  public execCmd(cmd: string, dataStream?: Writable, errStream?: Writable) {
    return new Promise<void>((resolve, reject) => {
      this.client.exec(cmd, (err: Error, stream: Channel) => {
        if (err) {
          return reject(err);
        }

        stream.on('close', () => resolve());

        if (dataStream) {
          stream.on('data', (data) => dataStream.write(data));
        } else {
          stream.on('data', (data) => stdout.write(data));
        }

        if (errStream) {
          stream.stderr.on('data', (data) => errStream.write(data));
        } else {
          stream.stderr.on('data', (data) => stderr.write(data));
        }
      });
    });
  }

  // handle remote shell stream processing
  protected remote_shell(err: Error, stream: Channel) {
    if (err) throw err;

    // disable local echo of input chars, use remote output only
    stdin.setRawMode(true);

    // forward data from local terminal to remote host
    stdin.on('data', (data) => {
      stream.stdin.write(data);
    });

    stream.stdout.on('data', (data) => {
      stdout.write(data);
    });

    // shutdown this process when stream ends (user logs out)
    stream.on('close', () => {
      stdin.setRawMode(false);
      stdin.removeAllListeners();
      stream.stdout.removeAllListeners();
      exit();
    }).stderr.on('data', (data) => {
      this.debug_en && this.debug('shell' + data);
    });
  }


  // remove ssh client event listeners
  protected cleanup_events(client: Client) {
    client.removeAllListeners('ssh_event');
  }

  // handle setting up ssh client and proxy forward ports
  public do_ssh_connect(opts: SSHConfig) {

    const _client = this.client;

    // create a new ssh client connection with supplied credentials and hostname/port
    return new Promise<void>((resolve) => {

      // close open sockets on server, otherwise initialize open sockets storage
      this.shutdown_client(opts);
      //this.close_sockets(opts.proxy_ports);

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

        if (opts.remote_ports) {
          await this.setupRemotePorts(opts.remote_ports)
            .catch((err) => {
              this.debug_en && this.debug('error setting remote ports:', err);
              throw err;
            });
        }

        // if shell requested, enable remote terminal
        if (opts.shell) {
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
        this.shutdown_client(opts);
        //this.close_sockets(opts.proxy_ports);
      });

      _client.on('close', () => {
        this.debug_en && this.debug('SSH Client :: close');
        this.shutdown_client(opts);
        //this.close_sockets(opts.proxy_ports);
      });

      _client.on('error', (err: Error) => {
        this.debug_en && this.debug('SSH Client :: error :: ' + err);
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
      config.debug = (this.debug_ssh) ? (msg) => { console.log(msg) } : undefined;
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
    if (isNaN(port) || port < 1 || port > 65535 || (port < 1024 && whitelist && whitelist[port] === undefined)) return false;
    return true;
  }

  // validate local forwards for correct format and valid ports
  public validate_local_forward(proxy_ports: Array<string>, whitelist: object) {

    if (!proxy_ports) return true;

    const invalid_ports = [];

    proxy_ports.forEach((proxy_port: string) => {
      const [local_port, remote_hostname, remote_port] = proxy_port.split(':');
      if (remote_hostname.length < 1) invalid_ports.push({ port: remote_port, type: 'remote' });
      if (!this.validate_port_number(parseInt(local_port), whitelist))
        invalid_ports.push({ port: local_port, type: 'local' });
      if (!this.validate_port_number(parseInt(remote_port), whitelist))
        invalid_ports.push({ port: remote_port, type: 'remote' });
    });
    if (invalid_ports.length) {
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
    if (this.retries++ < 10) {
      this._tunnelReadyTimeout = setTimeout(invoke, 5000);
    } else {
      this.debug_en && this.debug(`Retry attempts exhausted.`);
    }
  }

  // attempt to establish ssh tunnel to server with supplied parameters.
  protected async ssh_start_tunnel(opts: SSHConfig) {
    const do_ssh_connect = async (resolve) => {
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
  public async connectSSH(opts: SSHConfig, whitelist: object | null) {
    // make deep copy of opts for modification
    const _opts = JSON.parse(JSON.stringify(opts));

    // setup whitelist from param or opts in case of error retry
    _opts.whitelist = whitelist !== undefined ? whitelist : _opts.whitelist ? _opts.whitelist : null;

    // validate local port forwards, emit error and quit if invalid
    try {
      this.validate_local_forward(_opts.proxy_ports, _opts.whitelist);
    } catch (err) {
      this.debug_en && this.debug(err);
      throw (err);
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
        this.debug_en && this.debug(err);
        throw (err);
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
        this.debug_en && this.debug(err);
        throw (err);
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
    this.emit('debug', ...args);
  }
}

export { KeypairStorage, NgrokApi, main as sshcli };
