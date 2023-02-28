import { readFileSync } from 'fs';
import { timingSafeEqual } from 'crypto';
import { Socket } from 'net';
import { Server } from 'electron-ssh2';
import { SSHTestServer } from './SSHTestServer';
import { SSHTestClient } from './SSHTestClient';
import { SSHTunnelProxy, SSHConfig, KeypairStorage } from '../../src';
import { SSHTestBenchConfig, SSHServerConfig } from './SSHTestBenchTypes';

interface ServerSocket {
    [key: string]: Socket;
}

export class SSHTestBench {

    protected sshTunnelProxy: SSHTunnelProxy;
    protected sshServer: any;
    protected privateKey: string;
    protected publicKey: any;
    protected keypairStorage: KeypairStorage;
    protected serverSocket: ServerSocket;
    public clients:Array<SSHTestClient>;
    public servers:Array<SSHTestServer>;

    constructor() {

        this.keypairStorage = new KeypairStorage();

        // read test hostkeys
        this.privateKey = readFileSync('./config/ed25519').toString();
        this.publicKey = this.keypairStorage.get_public_key_from_private(this.privateKey);
        this.serverSocket = {};
    }

    protected checkValue(input, allowed) {
        const autoReject = (input.length !== allowed.length);
        if (autoReject) {
            // Prevent leaking length information by always making a comparison with the
            // same input when lengths don't match what we expect ...
            allowed = input;
        }
        const isMatch = timingSafeEqual(input, allowed);
        return (!autoReject && isMatch);
    }

    protected async startSSHServer(config: SSHServerConfig) {
        return new Promise<void>((resolve, reject) => {
            const debugMsg = (msg) => {
                //console.log(msg);
            }

            // instantiate new ssh server
            this.sshServer = new Server({ port: config.port, hostKeys: [this.privateKey], debug: debugMsg }, (client) => {
                client.on('authentication', (ctx) => {
                    switch (ctx.method) {
                        case 'password':
                            break;
                        case 'publickey':
                            if (ctx.key.algo !== this.publicKey.type
                                || !this.checkValue(ctx.key.data, this.publicKey.getPublicSSH())
                                || (ctx.signature && this.publicKey.verify(ctx.blob, ctx.signature) !== true)) {
                                return ctx.reject();
                            }
                            break;
                    }
                    ctx.accept();
                })

                client.on('request', async (accept, reject, name, info) => {
                    if (name === 'tcpip-forward') {
                        const forwardServer = new SSHTestServer({ name: 'forward out', port: info.bindPort });
                        await forwardServer.startServer(false);
                        accept(info.bindPort);
                        client.forwardOut(info.bindAddr, info.bindPort, 'remote', 12345, (err, channel) => {
                            if (err) {
                                console.log(err);
                                return;
                            }
                            forwardServer.setForward(channel);
                        });
                    }
                });

                client.on('tcpip', (accept, reject, info) => {
                    if (!this.serverSocket[info.destPort]) {
                        const socket = new Socket();
                        socket.on('ready', () => {
                            this.serverSocket[info.destPort] = socket;
                            const channel = accept();
                            channel.pipe(socket);
                            socket.pipe(channel);
                            socket.on('end', () => {
                                console.log('closing forward:' + info.destPort);
                                channel.unpipe(socket);
                                socket.unpipe(channel);
                                delete this.serverSocket[info.destPort];
                            });
                        });
                        socket.on('error', (err) => {
                            console.log('forward error:' + err);
                            reject();
                        });
                        socket.connect({ port: info.destPort });
                    }
                });

            }).listen(config.port, config.host, () => {
                resolve();
            });
        });
    }

    public async setupTestBench(config: SSHTestBenchConfig) {

        function printTestData(msg) {
            //console.log(JSON.stringify(msg) + '\n');
        }

        const servers: Array<SSHTestServer> = [];
        config.server.forEach(async (serverConfig) => {
            const server = new SSHTestServer(serverConfig);
            servers.push(server);
            server.on('test', printTestData);
            await server.startServer(true);
        });
        this.servers = servers;

        // start ssh server
        await this.startSSHServer(config.sshServer);

        const localLinks: Array<string> = [];
        const remoteLinks: Array<string> = [];
        config.link.forEach(async (link) => {
            const client = config.client.find(element => element.name === link.client);
            const server = config.server.find(element => element.name === link.server);
            // throw error if client or server not found
            if (!client || !server) return;
            if (link.dest === 'remote') remoteLinks.push([client.port, server.host, server.port].join(':'));
            else if (link.dest === 'local') localLinks.push([server.port, server.host, client.port].join(':'));
        });

        // setup ssh tunnel connection parameters
        const tunnelConfig: SSHConfig = {
            hostname: config.sshClient.name,
            username: config.sshClient.username,
            host: config.sshServer.host,
            port: config.sshServer.port.toString(),
            private_key_filename: config.sshClient.key,
            proxy_ports: remoteLinks,
            remote_ports: localLinks
        }

        // init ssh tunnel proxy
        this.sshTunnelProxy = new SSHTunnelProxy();
        //this.sshTunnelProxy.debug_en = true;
        //this.sshTunnelProxy.debug_ssh = true;
        await this.sshTunnelProxy.connectSSH(tunnelConfig, null);

        const clients: Array<SSHTestClient> = [];
        config.client.forEach(async (clientConfig) => {
            const client = new SSHTestClient(clientConfig);
            clients.push(client);
            client.on('test', printTestData);
            await client.initClient().catch((err: Error) => {
                console.log(err);
            });
        });
        this.clients = clients;
        return clients;
    }
}
export { TestMessage } from './TestMessage';
