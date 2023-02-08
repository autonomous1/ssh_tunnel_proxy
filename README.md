# ssh_tunnel_proxy
Initiate a ssh reverse tunnel proxy with forwarding ports

ssh_tunnel_proxy is a wrapper to ssh2 that provides async functionality as well as an extension to the api to include methods to setup a list of proxy forwards, exec a list of commands or startup a terminal shell. To setup a ssh tunnel, parameters are suppled for host, port, authentication and a list of proxy ports or commands to invoke. If a ngrok api key is provided the host and port of the ngrok tunnel are obtained. If the connection is interrupted or connection errors occur, attempts are made re-establish the tunnel.

In addition to the node api, a command line function called ssh-node2 is included to start ssh sessions in a manner similar to the ssh command line utility.

### Command line examples

Connect to remote host and establish local forwards:

```
./ssh2-node -u=<username> -h=192.168.1.1 -k=~/.ssh/<private_key> -L=8180:192.168.1.1:80
```

Connect to host using parameters stored in ~/.config/ssh_tunnel_proxy/config.json:

```
./ssh2-node rh2
```

default config file, located at:
~/.config/ssh_tunnel_proxy/config.json
```json
[{
  "hostname":"rh2",
  "username": "<username>",
  "proxy_ports": [
    "8280:127.0.0.1:80",
    "9000:127.0.0.1:9000",
    "8122:192.168.2.1:22"
  ],
  "private_key_filename":"~/.ssh/<private key>",
  "ngrok_api": "<ngrok api key>"
}]
```

Execute a series of commands on remote host
```
./ssh-node2 -e='uptime' -e='ls -all'
```

### Api examples

Exec remote commands using async await and processing result through streams.

```js
// send result of cmd through pipeline, generating a stream of json objects
function lsTest(cmdProxy, cmd) {

    return new Promise( (resolveCmd) => {

             // set input of pipeline to split data into lines (npm i split)
            const tunnel = split();

            // when pipeline is ready exec shell cmd
            const pipelineReady = (socket) => {

                return new Promise((resolve) => {

                  // invoke command on remote host and send results to pipeline
                  cmdProxy.execCmd(cmd, tunnel)

                        // stream processing complete, cleanup pipeline and exit
                        .then(() => {
                            //self.cleanupPipeline(socket);
                            resolveCmd();
                        });
                    resolve();
                })
            }

            // pipe shell cmd result through json parser pipeline to destination
            pipeline(tunnel,
                self.parse(),
                destination,
                pipelineReady
            );
    })
}

async function runCmd() {

  const opts = {
    "hostname":"rh2",
    "username": "<username>",
    "private_key_filename":"~/.ssh/<private key>",
    "ngrok_api": "<ngrok api key>"
  }

  const sshTunnelProxy = new SSHTunnelProxy();

  // connect to remote host
  await sshTunnelProxy.connectSSH(opts);

  // invoke ls -all on remote host and parse result to json object string
  await lsTest(sshTunnelProxy, 'ls -all');
}

runCmd();
```

Example of use of the api with electronjs.

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