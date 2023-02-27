import { EventEmitter } from 'events';
import { Server, createServer, Socket } from 'net';
import { JSONStream } from './JSONStream';
import { TestConfig } from './SSHTestBenchTypes';

export class SSHTestServer extends EventEmitter {

    protected name: string;
    protected port: number;
    protected socket: Socket;
    protected server: Server;
    protected jsonStream: JSONStream;
    protected channel: any;

    constructor(config: TestConfig) {
        super();
        this.name = config.name;
        this.port = config.port;
        this.jsonStream = new JSONStream();
    }

    public setForward(channel) {
        this.channel = channel;
    }

    public async startServer(hasRespond:boolean) {
        return new Promise<void>((resolve, reject) => {
            try {

                this.server = createServer(async (socket) => {

                    const respond = (obj: object) => {
                        const data_obj = {};
                        if (obj instanceof Object) {
                            data_obj['response'] = obj['contents'];
                        }
                        const testData = {
                            from: this.name,
                            to:obj['from'],
                            type: 'response',
                            contents: data_obj
                        }

                        // write response back to client
                        socket.write(JSON.stringify(testData) + '\n');
                        this.emit('test', obj);
                    }

                    this.socket = socket;
                    if (hasRespond) {
                        this.jsonStream.process = respond;
                        await this.jsonStream.init(socket);
                    }
                    if (this.channel) {
                        this.socket.pipe(this.channel);
                        this.channel.pipe(this.socket);
                    }

                });

                // start listening on port
                this.server.listen(this.port, () => {

                    // emit server listening on port message
                    const testData = {
                        port: this.port,
                        type: 'server ready',
                        data: 'socket server bound on ' + this.port
                    }
                    this.emit('test', testData);
                    resolve();

                });

            } catch (err) {
                console.log(err);
            }
        });
    }
}
