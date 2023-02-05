# ssh_tunnel_proxy
Initiate a ssh reverse tunnel proxy with forwarding ports

ssh_tunnel_proxy can function as a stand-alone api, nodejs command line script or as part of an electron_js app. To setup a ssh tunnel, parameters are suppled for host, port, authentication and a list of proxy ports. If a ngrok api key is provided the host and port of the ngrok tunnel are obtained. A list of port forwards is provided and is validated to restrict connections to system ports on the remote host to a list of pre-defined ports such as http or https. After establishing a ssh connection on the remote server, local proxy port forwards are opened. If the connection is interrupted or connection errors occur, attempts are made re-establish the tunnel.

Example command line to establish a list of local forwards:

```
node main.js -c
```

default config file, located at:
~/.config/ssh_tunnel_proxy/config.json
```json
[{
  "enabled": true,
  "username": "<username>",
  "password": "",
  "host": "",
  "port": "",
  "proxy_ports": [
    "8280:127.0.0.1:80",
    "9000:127.0.0.1:9000",
    "8122:192.168.2.1:22"
  ],
  "whitelist": {
    "80": true,
    "443": true,
    "22": true
  },
  "service_name": "ssh_proxy_client",
  "server_name": "test",
  "ngrok_api": "<ngrok api key>"
}]
```

Command line to execute a series of commands on remote host:
```
node main.js -c -e='uptime' -e='ls -all'
```

Or execute commands defined in default config:
```
node main.js -c
```
```json
[{
  "enabled": true,
  "username": "<username>",
  "service_name": "ssh_proxy_client",
  "server_name": "test",
  "exec" : [
    "uptime",
    "ls -all"
  ],
  "ngrok_api": "<ngrok api key>"
}]
```

Start a terminal session on the remote host:
```
node main.js -c -S
```

Example use of api to exec remote commands using async await and processing result through streams. Complete example is in test/test_remote_exec.js:

```js
// lsLongShellProc to json stream test
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
        console.log('\ninvoking ' + lscmd + ' on remote host:\n');
        await sshTunnelProxy.execCmd(lscmd, tunnel);

        // stream processing complete
        console.log('ls -all completed');
        resolve();
    })
}

async function runTests() {

    const sshTunnelProxy = new SSHTunnelProxy();

    // connect to remote host
    await sshTunnelProxy.connectSSH(opts);

    // invoke ls -all on remote host and parse result to json object string
    await lsTest(sshTunnelProxy);

    process.exit();
}

runTests();
```

The following code is an example of use of the api with electronjs.

main.js:
```js

async function init_sshTunnelProxy(win) {

  const { SSHTunnelProxy } = require('ssh_tunnel_proxy');
  const sshTunnelProxy = new SSHTunnelProxy();
  
  ipcMain.on('connect_ssh_sync', async function(event,opts) {
    // only allow connection on remote server to system ports http,https,ssh and user ports >1023
    const portWhitelist = {
      80:true,
      443:true,
      22:true
    }
    await sshTunnelProxy.connectSSH(opts, portWhitelist);
    event.returnValue = 'connected';
  });

  ipcMain.on('generate_keypair', async (event, ...args) => await sshTunnelProxy.generateAndStoreKeypair(...args));

  ipcMain.on('get_public_key', async (event, ...args) => await sshTunnelProxy.getPublicKey(...args));

  ipcMain.on('network_online', (event, ...args) => sshTunnelProxy.onNetworkOnline(...args));

  ipcMain.on('network_offline', (event, ...args) => sshTunnelProxy.onNetworkOffline(...args));

  sshTunnelProxy.on('ready',(...args) => win.webContents.send('ready',...args));

  sshTunnelProxy.on('debug',(...args) => win.webContents.send('debug',...args));

  sshTunnelProxy.on('error',(...args) => win.webContents.send('error',...args));

};
```

preload.js:
```js
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('sshModule', {
    connect_ssh_sync: opts => ipcRenderer.sendSync('connect_ssh_sync', opts),
    generate_keypair: (...args) => ipcRenderer.sendSync("generate_keypair", ...args),
    get_public_key: (...args) => ipcRenderer.sendSync("get_public_key", ...args),
    network_online: (...args) => ipcRenderer.send("network_online", ...args),
    network_offline: (...args) => ipcRenderer.send("network_offline", ...args),
    ready: (callback) => ipcRenderer.on('ready', callback),
    debug: (callback) => ipcRenderer.on('debug', callback),
    error: (callback) => ipcRenderer.on('error', callback)
});
```

// render process
```js
// initialize ssh message handlers
sshModule.ready((event, data) => {
});
sshModule.debug((event,msg)=>{
})
sshModule.error((event,err)=>{
});

// options for connect_ssh_sync
var sshParams = {
  "username": "<username>",
  "password": "",
  "host": "",
  "port": "",
  "proxy_ports": [
    "8280:127.0.0.1:80",
    "9000:127.0.0.1:9000",
    "8122:192.168.2.1:22"
  ],
  "service_name": "service",
  "server_name": "server",
  "ngrok_api": "<ngrok_api_key>"
};

// initate ssh tunnel
sshModule.connect_ssh_sync(sshParams);
```