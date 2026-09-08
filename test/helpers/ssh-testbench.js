/*
 * ssh-testbench.js — a self-contained, in-process SSH server for integration
 * tests.
 *
 * It requires no external sshd, no keys on disk, no personal config file and no
 * network beyond loopback, so `npm test` behaves the same on a workstation and in
 * CI. It implements exactly the four things this library depends on:
 *
 *   - publickey authentication for one generated test key
 *   - direct-tcpip  (what a local forward asks for)
 *   - tcpip-forward (what a remote forward asks for)
 *   - session/exec  (so exec() can be verified)
 *
 * License: MIT
 */

const net = require('node:net');
const { Server, utils } = require('ssh2');

const { parseKey } = utils;

function usableKeyPair() {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const pair = utils.generateKeyPairSync('ed25519');
    const parsedPrivate = parseKey(pair.private);
    const parsedPublic = parseKey(pair.public);
    if (!(parsedPrivate instanceof Error) && !(parsedPublic instanceof Error)) {
      return pair;
    }
  }
  throw new Error('ssh2 generateKeyPairSync produced unusable ed25519 keys');
}

class SSHTestBench {
  constructor() {
    this.hostKey = usableKeyPair();
    this.clientKey = usableKeyPair();
    this.parsedClientKey = parseKey(this.clientKey.public);
    this.server = null;
    this.port = 0;
    this.clients = new Set();
    /** bindKey -> { listener, bindPort, client } for each tcpip-forward. */
    this.remoteBinds = new Map();
    this.rejectDirectTcpip = false;
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

    client.on('error', () => {
      /* client-side teardown noise */
    });

    client.on('ready', () => {
      // direct-tcpip: dial the requested destination and pipe both ways.
      client.on('tcpip', (accept, reject, info) => {
        if (this.rejectDirectTcpip) return reject();

        const target = net.connect(info.destPort, info.destIP);
        let channel = null;

        target.once('connect', () => {
          channel = accept();
          if (!channel) {
            target.destroy();
            return;
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
      });

      // tcpip-forward: bind a real loopback listener and open a
      // forwarded-tcpip channel back to the client for each connection.
      client.on('request', (accept, reject, name, info) => {
        if (name === 'tcpip-forward') {
          const listener = net.createServer((socket) => {
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
        session.once('exec', (acceptExec, rejectExec, info) => {
          const stream = acceptExec();
          stream.write(`ran:${info.command}\n`);
          stream.exit(0);
          stream.end();
        });
      });
    });
  }

  /** The port the peer actually bound for a requested bind port. */
  boundPortFor(requested) {
    for (const entry of this.remoteBinds.values()) {
      if (entry.requested === requested || entry.bindPort === requested) return entry.bindPort;
    }
    return undefined;
  }

  /** Simulate a transport drop without shutting the server down. */
  dropConnections() {
    for (const client of [...this.clients]) {
      try {
        client.end();
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

/** A TCP echo server used as a forward target. Echoes `prefix + data`. */
class EchoServer {
  constructor(prefix = '') {
    this.prefix = prefix;
    this.server = net.createServer((socket) => {
      this.connectionCount += 1;
      this.sockets.add(socket);
      socket.on('data', (chunk) => {
        socket.write(this.prefix + chunk.toString());
      });
      socket.on('error', () => socket.destroy());
      socket.on('close', () => this.sockets.delete(socket));
    });
    this.sockets = new Set();
    this.connectionCount = 0;
    this.port = 0;
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
    for (const socket of [...this.sockets]) socket.destroy();
    await new Promise((resolve) => this.server.close(resolve));
  }
}

/** Send one line to host:port and resolve with the first response chunk. */
function roundTrip(port, message, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = net.connect(port, host);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`round trip to ${host}:${port} timed out`));
    }, 5000);

    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    socket.once('connect', () => socket.write(message));
    socket.once('data', (chunk) => {
      clearTimeout(timer);
      settled = true;
      const text = chunk.toString();
      socket.end();
      resolve(text);
    });
    socket.once('close', () => {
      if (settled) return;
      clearTimeout(timer);
      reject(new Error(`connection to ${host}:${port} closed without a reply`));
    });
  });
}

/** Hold a connection open so concurrency can be observed. */
function openConnection(port, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, host);
    socket.once('error', reject);
    socket.once('connect', () =>
      resolve({
        socket,
        send(message) {
          return new Promise((res, rej) => {
            const timer = setTimeout(() => rej(new Error('send timed out')), 5000);
            const onData = (chunk) => {
              clearTimeout(timer);
              socket.off('close', onClose);
              res(chunk.toString());
            };
            const onClose = () => {
              clearTimeout(timer);
              socket.off('data', onData);
              rej(new Error('connection closed before a reply'));
            };
            socket.once('data', onData);
            socket.once('close', onClose);
            socket.write(message);
          });
        },
        close() {
          socket.destroy();
        },
      }),
    );
  });
}

/** A free loopback port, for negative tests that must not bind anything. */
function freePort() {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

module.exports = { usableKeyPair, SSHTestBench, EchoServer, roundTrip, openConnection, freePort };
