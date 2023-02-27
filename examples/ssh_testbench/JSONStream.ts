import { EventEmitter } from 'events';
import { Socket } from 'net';
import { pipeline } from 'stream';
//import { pipeline } from 'node:stream/promises';
import split from 'split';
import { obj as through2 } from 'through2';

export class JSONStream extends EventEmitter {
    protected socket: Socket;
    protected port: number;
    protected split: any;
    protected JSONData: any;
    public process: any;

    constructor() {
        super();
    }

    JSONStream() {
        return through2(function (data, enc, cb) {
            try {
                const obj = JSON.parse(data);
                this.push(obj);
            } catch (err) {
                return cb(err);
            }
            cb();
        });
    }

    public async init(socket:Socket) {
        return new Promise<void>((resolveSocket, reject) => {

            this.socket = socket;
            this.split = split();
            this.JSONData = this.JSONStream();
            this.JSONData.on('data', this.process);

            socket.on('end', () => {
                console.log('client end:');
            });

            socket.on('error', (err) => {
                reject(err);
            });

            const pipelineReady = () => {
                return new Promise<void>((resolve) => {
                    resolve();
                    resolveSocket();
                });
            }

            pipeline(socket,
                this.split,
                this.JSONData,
                pipelineReady
            );

        })
    }
}