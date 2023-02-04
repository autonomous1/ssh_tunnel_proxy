/*

test remote exec streams

*/

//const assert = require('assert');
//const { describe, it } = require('mocha');
const process = require('process');
const fs = require('fs');
const { PassThrough } = require("stream");
const through = require('through');
const split = require('split');

const { SSHTunnelProxy } = require('../lib/index.js');

// get config file containing api keys
const homedir = require('os').homedir();
var config = null;
try {
    config = JSON.parse(fs.readFileSync(homedir + '/.config/ssh_tunnel_proxy/config.json'), 'utf8');
} catch (err) {
    console.log('Error reading config');
    process.exit();
}

if (!config && !config[1]) {
    console.log('Specified config not found in configs');
    process.exit();
}

const opts = config[1];

const sshTunnelProxy = new SSHTunnelProxy();

// parse shell command result into array of strings
function parse_cmd(str) {

    let result = [];
    let log_matches = false;

    let regex = /(([\w-/_~]+)|("(.*?)")|('(.*?)'))/g;
    let groups = [2, 4, 6];
    let match;

    while ((match = regex.exec(str)) !== null) {
        // This is necessary to avoid infinite loops 
        // with zero-width matches
        if (match.index === regex.lastIndex) {
            regex.lastIndex++;
        }

        // For this to work the regex groups need to 
        // be mutually exclusive
        groups.forEach(function (group) {
            if (match[group]) {
                result.push(match[group]);
            }
        });

        // show matches for debugging
        log_matches && match.forEach(function (m, group) {
            if (m) {
                console.log(`Match '${m}' found in group: ${group}`);
            }
        });
    }
    return result;
}

// generate object from arrays of names/values
function toObj(names, values) {
    const obj = {};
    for (var i = 0; i < names.length; i++) {
        obj[names[i]] = values[i];
    }
    return obj;
}

// stream that receives single line of ls long data and converts to json object
const to_ls_JSON = new through(function (data) {
    const file = processLSLong(data);
    if (file.name) this.queue(file);
});

// stream that receives objects and converts to JSON strings
const to_JSON_string = new through(function (data) {
    this.queue(JSON.stringify(data) + '\n');
});

// parse ls long line output into json object
function processLSLong(line) {
    const format10 = ['pm', 'links', 'user', 'group', 'size', 'M', 'D', 'H', 'MM', 'name'];
    const format9 = ['pm', 'links', 'user', 'group', 'size', 'M', 'D', 'Y', 'name'];
    const values = parse_cmd(line);
    const obj = toObj((values.length < 10) ? format9 : format10, values);
    if (obj.pm) {
        obj.type = obj.pm.substring(0, 1);
        obj.pm = obj.pm.substring(1);
    }
    if (obj.M && obj.D) {
        obj.date = obj.M + ' ' + obj.D;
        delete obj.M;
        delete obj.D;
        if (obj.Y) {
            obj.date += ' ' + obj.Y;
            delete obj.Y;
        }
    }
    if (obj.H && obj.MM) {
        obj.time = obj.H + ':' + obj.MM;
        delete obj.H;
        delete obj.MM;
    }
    return obj;
}

async function test_exec_stream() {
    sshTunnelProxy.debug_en = true;
    await sshTunnelProxy.connectSSH(opts);

    // exec remote command and save result to string
    const uptime_result = await sshTunnelProxy.execCmd('uptime');
    console.log('uptime:' + uptime_result.toString());

    // exec remote command and pipe data through tunnel until no data
    const tunnel = new PassThrough();
    tunnel.pipe(split())
        .pipe(to_ls_JSON)
        .pipe(to_JSON_string)
        .pipe(process.stdout);

    await sshTunnelProxy.execCmd('ls -all', tunnel);

    // stream processing complete
    console.log('done');
    process.exit();
}

test_exec_stream();
