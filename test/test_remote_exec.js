/*
test exec cmd on remote server, parse to json object stream
*/

//const assert = require('assert');
//const { describe, it } = require('mocha');

const fs = require('fs');
const process = require('node:process');
const { SSHTunnelProxy } = require('..');
const { PassThrough, pipeline } = require("stream");
const through = require('through');
const split = require('split');

// get config file containing api keys
const homedir = require('os').homedir();
var config = null;
try {
    config = JSON.parse(fs.readFileSync(homedir + '/.config/ssh_tunnel_proxy/config.json'), 'utf8');
} catch (err) {
    console.log('Error reading config:' + err);
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

    let regex = /(([\w-/_~.\:\[\]]+)|("(.*?)")|('(.*?)'))/g;
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
        /*
        let log_matches = false;
        // show matches for debugging
        log_matches && match.forEach(function (m, group) {
            if (m) {
                console.log(`Match '${m}' found in group: ${group}`);
            }
        });
        */
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


// merge array items beginning at start into single item and append back to array
function mergeArray(ar, start) {
    const ar2 = ar.slice(start);
    const ar1 = ar.slice(0, start);
    const item = ar2.join(' ');
    ar1.push(item);
    return ar1;
}

/*
Feb  4 21:34:17 tim-ThinkPad-P50s systemd[1]: Started Run anacron jobs.
*/
function parseSyslog(line) {
    const format = ['M', 'D', 'T', 'host', 'proc', 'msg'];
    const values = parse_cmd(line);
    const log = mergeArray(values, 5);
    const obj = toObj(format, log);
    if (obj.M && obj.D && obj.T) {
        obj.date = obj.M + ' ' + obj.D + ' ' + obj.T;
        delete obj.M;
        delete obj.D;
        delete obj.T;
    }
    return obj;
}

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

function to_lsParse() {
    return new through(function (data) {
        const obj = processLSLong(data);
        if (obj.name) this.queue(obj);
    });
}

function to_syslogParse() {
    return new through(function (data) {
        const obj = parseSyslog(data);
        if (obj.proc) this.queue(obj);
    });
}

function to_JSONString() {
    return new through(function (data) {
        this.queue(JSON.stringify(data) + '\n');
    })
}

// lsLongShellProc conversion tests
async function lsTest(sshTunnelProxy) {
    return new Promise(async (resolve) => {

        // exec remote command and pipe data through tunnel until end of data
        const tunnel = new PassThrough();
        pipeline(tunnel,
            split(),
            to_lsParse(),
            to_JSONString(),
            process.stdout,
            () => { }
        );

        const lscmd = 'ls -all';
        //const lscmd = 'ls -all | column --table --table-columns pm,links,user,group,size,month,day,time,name -J';
        console.log('\ninvoking ' + lscmd + ' on remote host:\n');
        await sshTunnelProxy.execCmd(lscmd, tunnel);

        // stream processing complete
        console.log('ls -all completed');
        resolve();
    })
}

// lsLongShellProc conversion tests
async function syslogTest(sshTunnelProxy) {
    return new Promise(async (resolve) => {

        // exec remote command and pipe data through tunnel until end of data
        const tunnel = new PassThrough();
        pipeline(tunnel,
            split(),
            to_syslogParse(),
            to_JSONString(),
            process.stdout,
            () => { }
        );
        //const syslogcmd = 'tail /var/log/syslog | column --table --table-columns-limit 6 --table-columns month,day,time,host,proc,msg -J';
        const syslogcmd = 'tail /var/log/syslog';
        console.log('\ninvoking ' + syslogcmd + ' on remote host:\n');
        await sshTunnelProxy.execCmd(syslogcmd, tunnel);

        // stream processing complete
        console.log(syslogcmd+' completed');
        resolve();
    })
}

async function runTests() {

    // connect to remote host
    sshTunnelProxy.debug_en = true;
    await sshTunnelProxy.connectSSH(opts);

    // invoke ls -all on remote host and parse result to json object string
    await lsTest(sshTunnelProxy);

    // invoke tail /var/log/syslog on remote host and parse result to json object string
    await syslogTest(sshTunnelProxy);

    process.exit();
}

runTests();


