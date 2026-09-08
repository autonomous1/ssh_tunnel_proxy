/*
 * fault-injector.js — SSH server and TCP targets that fail on purpose.
 *
 * Wraps the happy-path SSHTestBench with injectable faults so each
 * TunnelError code and each operational failure mode can be forced
 * without a real network, sshd, or phone in the loop.
 */

const net = require('node:net');
const { Server, utils } = require('ssh2');
const { parseKey } = utils;
const { usableKeyPair } = require('./ssh-testbench');

class FaultySSHTestBench {
  constructor(faults = {}) {
    this.hostKey = usableKeyPair();
    this.clientKey = usableKeyPair();
    this.parsedClientKey = parseKey(this.clientKey.public);
    this.server = null;
    this.port = 0;
    this.clients = new Set();
    this.remoteBinds = new Map();
    this.faults = {
      rejectAuth: false,
      rejectDirectTcpip: false,
      rejectTcpipForward: false,
      delayDirectTcpipMs: 0,
      dropAfterBytes: 0,
      acceptThenReset: false,
      ...faults,
    };
    this.stats = {
      authAttempts: 0,
      directTcpip: 0,
      tcpipForward: 0,
      forwardedChannels: 0,
    };
  }

  setFault(name, value) {
    this.faults[name] = value;
  }

  async start() {
    this.server = new Server({ hostKeys: [this.hostKey.private] }, (client) => {
      this.clients.add(client);
      client.once('close', () => this.clients.delete(client));
      this._wireClient(client);
    });

    await new Promise((resolve) => {
      this.server.listen(0, '127.0.0.1', () => {
        this.port = this.server.address().port;
        resolve();
      });
    });
    return this.port;
  }

  _wireClient(client) {
    client.on('authentication', (ctx) => {
      this.stats.authAttempts += 1;
      if (this.faults.rejectAuth) return ctx.reject();

      if (ctx.method === 'publickey') {
        if (
          ctx.key.algo === this.parsedClientKey.type &&
          ctx.key.data.equals(this.parsedClientKey.getPublicSSH())
        ) {
          if (ctx.signature) {
            if (this.parsedClientKey.verify(ctx.blob, ctx.signature, ctx.hashAlgo)) {
              return ctx.accept();
            }
            return ctx.reject();
          }
          return ctx.accept();
        }
        return ctx.reject();
      }
      if (ctx.method === 'none') return ctx.reject(['publickey']);
      return ctx.reject(['publickey']);
    });

    client.on('error', () => {});

    client.on('ready', () => {
      client.on('tcpip', (accept, reject, info) => {
        this.stats.directTcpip += 1;
        if (this.faults.rejectDirectTcpip) return reject();

        const open = () => {
          const target = net.connect(info.destPort, info.destIP);
          let channel = null;
          let bytes = 0;

          target.once('connect', () => {
            if (this.faults.acceptThenReset) {
              target.destroy();
              return reject();
            }
            channel = accept();
            if (!channel) {
              target.destroy();
              return;
            }
            if (this.faults.dropAfterBytes > 0) {
              channel.on('data', (chunk) => {
                bytes += chunk.length;
                if (bytes >= this.faults.dropAfterBytes) {
                  channel.destroy();
                  target.destroy();
                }
              });
            }
            channel.pipe(target).pipe(channel);
            channel.once('close', () => target.destroy());
            target.once('close', () => {
              try {
                channel.destroy();
              } catch {
                channel.end();
              }
            });
          });

          target.once('error', () => {
            if (channel) {
              try {
                channel.destroy();
              } catch {
                channel.end();
              }
            } else {
              reject();
            }
          });
        };

        if (this.faults.delayDirectTcpipMs > 0) {
          setTimeout(open, this.faults.delayDirectTcpipMs);
        } else {
          open();
        }
      });

      client.on('request', (accept, reject, name, info) => {
        if (name === 'tcpip-forward') {
          this.stats.tcpipForward += 1;
          if (this.faults.rejectTcpipForward) {
            if (reject) reject();
            return;
          }

          const listener = net.createServer((socket) => {
            this.stats.forwardedChannels += 1;
            client.forwardOut(
              info.bindAddr,
              listener.address().port,
              socket.remoteAddress || '127.0.0.1',
              socket.remotePort || 0,
              (err, channel) => {
                if (err) {
                  socket.destroy();
                  return;
                }
                socket.pipe(channel).pipe(socket);
                channel.once('close', () => socket.destroy());
                socket.once('close', () => channel.end());
              },
            );
          });

          listener.on('error', () => reject && reject());
          listener.listen(info.bindPort, '127.0.0.1', () => {
            const bound = listener.address().port;
            this.remoteBinds.set(`${info.bindAddr}:${bound}`, {
              listener,
              bindPort: bound,
              requested: info.bindPort,
            });
            if (accept) accept(bound);
          });
          return;
        }

        if (name === 'cancel-tcpip-forward') {
          const key = `${info.bindAddr}:${info.bindPort}`;
          const entry = this.remoteBinds.get(key);
          if (entry) {
            entry.listener.close();
            this.remoteBinds.delete(key);
          }
          if (accept) accept();
          return;
        }

        if (reject) reject();
      });

      client.on('session', (acceptSession) => {
        const session = acceptSession();
        session.once('exec', (acceptExec) => {
          const stream = acceptExec();
          stream.write('ok\n');
          stream.exit(0);
          stream.end();
        });
      });
    });
  }

  dropConnections() {
    for (const client of [...this.clients]) {
      try {
        client.end();
      } catch {
        /* ignore */
      }
    }
  }

  /** Hard RST-style drop of every SSH client socket. */
  resetConnections() {
    for (const client of [...this.clients]) {
      try {
        client.destroy();
      } catch {
        /* ignore */
      }
    }
  }

  async stop() {
    for (const entry of this.remoteBinds.values()) {
      try {
        entry.listener.close();
      } catch {
        /* ignore */
      }
    }
    this.remoteBinds.clear();
    this.dropConnections();
    if (this.server) {
      await new Promise((resolve) => this.server.close(resolve));
      this.server = null;
    }
  }
}

/** TCP server that accepts then immediately resets. */
class ResetTarget {
  constructor() {
    this.port = 0;
    this.server = net.createServer((socket) => socket.destroy());
  }
  async start() {
    await new Promise((resolve) => {
      this.server.listen(0, '127.0.0.1', () => {
        this.port = this.server.address().port;
        resolve();
      });
    });
    return this.port;
  }
  async stop() {
    await new Promise((resolve) => this.server.close(resolve));
  }
}

/** TCP server that accepts, reads nothing, never replies. */
class BlackHoleTarget {
  constructor() {
    this.port = 0;
    this.sockets = new Set();
    this.server = net.createServer((socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
      socket.on('error', () => socket.destroy());
    });
  }
  async start() {
    await new Promise((resolve) => {
      this.server.listen(0, '127.0.0.1', () => {
        this.port = this.server.address().port;
        resolve();
      });
    });
    return this.port;
  }
  async stop() {
    for (const s of [...this.sockets]) s.destroy();
    await new Promise((resolve) => this.server.close(resolve));
  }
}

function waitFor(emitter, event, predicate = () => true, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.off(event, handler);
      reject(new Error(`timed out waiting for "${event}"`));
    }, timeoutMs);
    const handler = (payload) => {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      emitter.off(event, handler);
      resolve(payload);
    };
    emitter.on(event, handler);
  });
}

function expectCode(code) {
  return (err) => {
    if (!err || err.code !== code) {
      return false;
    }
    return true;
  };
}

/** TCP service that can be stopped and rebound on the same port. */
class RestartableService {
  constructor(prefix = '') {
    this.prefix = prefix;
    this.port = 0;
    this.server = null;
    this.sockets = new Set();
    this.starts = 0;
  }

  async start(port = this.port || 0) {
    this.server = net.createServer((socket) => {
      this.sockets.add(socket);
      socket.on('data', (chunk) => socket.write(this.prefix + chunk.toString()));
      socket.on('error', () => socket.destroy());
      socket.on('close', () => this.sockets.delete(socket));
    });
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, '127.0.0.1', () => {
        this.port = this.server.address().port;
        this.starts += 1;
        resolve();
      });
    });
    return this.port;
  }

  async stop() {
    for (const socket of [...this.sockets]) socket.destroy();
    this.sockets.clear();
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    await new Promise((resolve) => server.close(() => resolve()));
  }
}

function connectDeadline(port, host, timeoutMs = 400) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, host);
    const timer = setTimeout(() => {
      socket.destroy();
      const err = new Error(`connect to ${host}:${port} timed out after ${timeoutMs}ms`);
      err.code = 'ETIMEDOUT';
      reject(err);
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function firstNonLoopbackIPv4() {
  const os = require('node:os');
  const ifaces = os.networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const addr of list || []) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return undefined;
}

module.exports = {
  FaultySSHTestBench,
  ResetTarget,
  BlackHoleTarget,
  RestartableService,
  waitFor,
  expectCode,
  connectDeadline,
  firstNonLoopbackIPv4,
};
