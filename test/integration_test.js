const { randomUUID } = require('crypto');
const assert = require('assert');
const { describe, it, after } = require('mocha');

const { SSHTestBench, TestMessage } = require('../examples/build/examples/ssh_testbench/SSHTestBench');

describe('initialize ssh server and tunnel', function () {
    it('should start testbench', async function () {

        const sshTestBench = new SSHTestBench();
        const config = require('../config/testconfig1.json');

        describe('Initialize ssh server and tunnel', function () {
            it('testbench should be initialized without errors', async function () {

                await sshTestBench.setupTestBench(config);

                const clients = sshTestBench.clients;
                const servers = sshTestBench.servers;

                describe('Clients and servers have been initialized', function () {
                    it('clients exist', function () {
                        assert(clients, 'testbench clients initialized successfully');
                    });
                    it('servers exist', function () {
                        assert(servers, 'testbench servers initialized successfully');
                    });
                });

                // remote/local forwarding integration test
                let clientName = '';
                let serverName = '';
                const integrationTest = () => {

                    // obtain client,server from test configuration
                    const client = clients.find(element => element.name === clientName);
                    const server = servers.find(element => element.name === serverName);

                    // confirm client, server obtained correctly
                    it('client found:'+clientName, function () {
                        assert(client, 'testbench client initialized successfully');
                    });
                    it('server found:'+serverName, function () {
                        assert(server, 'testbench server initialized successfully');
                    });

                    // initialize test message
                    const message = new TestMessage();
                    const msg_data = client.name + ' request ' + randomUUID();
                    const msg = message.generateMessage(client.name, 'server', 'test', msg_data);

                    // test message received by server from client
                    describe('Request received by '+serverName, function () {
                        it('Correct request received from '+clientName, function () {
                            return new Promise((resolve, reject) => {
                                const serverDataMsg = (data) => {
                                    assert(data, 'should contain original message');
                                    assert.equal(data.contents, msg_data, 'should contain client request message');
                                    resolve();
                                };
                                server.on('test', serverDataMsg);
                                client.sendMessage(msg);
                            });
                        });
                    });

                    // test message received by client from server
                    describe('Response received by '+clientName, function () {
                        it('Correct response received from '+serverName, function () {
                            return new Promise((resolve, reject) => {
                                const clientDataMsg = (data) => {
                                    //console.log('client data received' + JSON.stringify(data));
                                    assert(data, 'should contain original message');
                                    assert.equal(data.contents.response, msg_data, 'should contain original message');
                                    resolve();
                                };
                                client.on('test', clientDataMsg);
                                client.sendMessage(msg);
                            });
                        });
                    });
                };

                // test local forwarding
                clientName = 'local client1';
                serverName = 'remote server';
                describe('Local client to remote server integration test', integrationTest);

                // test remote forwarding
                clientName = 'remote client2';
                serverName = 'local server';
                describe('Remote client to local server integration test', integrationTest);

            });
        });
    });
});

