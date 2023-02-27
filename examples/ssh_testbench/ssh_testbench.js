const { readFileSync } = require('fs');
const { randomUUID } = require('crypto');
const { SSHTestBench, TestMessage } = require('../build/examples/ssh_testbench/SSHTestBench');

async function runTest() {
    const sshTestBench = new SSHTestBench();
    const config = JSON.parse(readFileSync('testconfig/testconfig1.json').toString());

    const clients = await sshTestBench.setupTestBench(config);

    const message = new TestMessage();
    clients.forEach(async (client) => {
        let msgCounter = 0;
        setInterval(() => {
            const msg_data = client.name + ' request ' + msgCounter++ + ' ' + randomUUID();
            const msg = message.generateMessage(client.name, 'server', 'test', msg_data);
            client.sendMessage(msg);
        }, 1000);
    });
}
runTest();
