const process = require('process');
const fs = require('fs');
const { SSHTunnelProxy, KeypairStorage } = require('./lib/index.js');

const keypairStorage = new KeypairStorage();
const homedir = require('os').homedir();
var debug = false;
var proxies = [];
var configs = null;
var host = null;
var port = null;
var username = null;
var password = null;
var forwardOut = [];
var forwardIn = [];
var ngrokAPIKey = null;
var privateKey = null;
var service = null;
var account = null;

function get_key_from_file(filename) {
    try {
        return fs.readFileSync(filename);
    } catch (err) {
        console.log('Error loading key:', err);
    }
}

function get_config(filename) {
    try {
        configs = JSON.parse(fs.readFileSync(filename), 'utf8');
    } catch (err) {
        console.log('Error loading config file:', err);
    }
}

function get_default_config() {
    try {
        configs = JSON.parse(fs.readFileSync(homedir + '/.config/ssh_tunnel_proxy/config.json'), 'utf8');
    } catch (err) {
        console.log('Error loading config file:', err);
    }
}

function main(args) {

    // parse command line args
    for (let i = 0; i < args.length; i++) {
        const arg = args[i].split('=');
        const cmd = arg[0];
        const value = arg[1];
        switch (cmd) {
            case '-d':
            case '--debug':
                debug = true;
                break;
            case '-c':
            case '--config':
                if (value) get_config(value);
                else get_default_config();
                break;
            case '-h':
            case '--host':
                host = value;
                break;
            case '-p':
            case '--port':
                port = value;
                break;
            case '-u':
            case '--username':
                username = value;
                break;
            case '-P':
            case '--password':
                password = value;
                break;
            case '-k':
            case '--key':
                privateKey = value;
                break;
            case '-s':
            case '--service':
                service = value;
                break;
            case '--a':
                account = value;
                break;
            case '-L':
            case '--LocalForward':
                forwardOut.push(value);
                break;
            case '-R':
            case '--RemoteForward':
                forwardIn.push(value);
                break;
            case '-n':
            case '--ngrok':
                ngrokAPIKey = value;
                break;
            default:
                if (i > 1) console.log('Invalid argument:', arg);
        }
    }

    // prevent process from exiting
    process.stdin.resume();

    // if no config file specified, build config from args
    if (!configs) {
        var config = {
            enabled: true,
            username: username,
            password: password,
            host: host,
            port: port,
            proxy_ports: forwardOut,
            remote_ports: forwardIn,
            service_name: service,
            server_name: account,
            ngrok_api: ngrokAPIKey,
            private_key: privateKey
        };
        configs = [config];
    }

    // process each tunnel config in ssh proxy tunnel list
    configs.forEach(async config => {

        // skip tunnel if not enabled
        if (!config.enabled) return;

        // if system key storage name specified get key from system keychain
        if (config.server_name) {
            const service_name = config.service_name || 'ssh_tunnel_proxy';
            config.private_key = await keypairStorage.get_keypair(service_name, config.server_name);
        }
        // if private key filename specified, read private key
        else if (config.private_key) {
            config.private_key = get_key_from_file(config.private_key);
        }

        // create new tunnel and start connection
        var sshTunnelProxy = new SSHTunnelProxy();
        proxies.push(sshTunnelProxy);
        sshTunnelProxy.debug_en = debug;
        sshTunnelProxy.connectSSH(config);
    });


}

main(process.argv);