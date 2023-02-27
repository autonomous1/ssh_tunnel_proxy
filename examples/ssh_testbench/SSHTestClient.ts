import { EventEmitter } from 'events';
import { Socket } from 'net';
import { TestConfig } from './SSHTestBenchTypes';
import { JSONStream } from './JSONStream';

export class SSHTestClient extends EventEmitter {

    protected socket: Socket;
    protected port: number;
    protected jsonStream: JSONStream;
    public name: string;

    constructor(config: TestConfig) {
        super();
        this.name = config.name;
        this.port = config.port;
        this.jsonStream = new JSONStream();
    }

    public async initClient() {
        return new Promise<void>((resolve, reject) => {

            this.jsonStream.process = (data) => {
                this.emit('test', data);
            };
            const socket = new Socket();
            this.socket = socket;
            socket.on('ready', async () => {
                const testData = {
                    port: this.port,
                    type: 'client ready',
                    data: 'client connected'
                }
                this.emit('test', testData);
                await this.jsonStream.init(socket);
                resolve();
            });
            socket.connect({ port: this.port, keepAlive: true });
        })
    }

    public sendMessage(msg) {
        msg instanceof Object && (msg['from'] = this.name)
        const str_msg = ((msg instanceof Object) ? JSON.stringify(msg) : msg) + '\n';
        this.socket.write(str_msg);
    }
}