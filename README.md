# ssh_tunnel_proxy
Initiate a ssh reverse tunnel proxy with forwarding ports

ssh_tunnel_proxy can function as a stand-alone api, nodejs command line script or part of an electron_js app. To establish a ssh tunnel proxy a keypair is generated on the client and stored in the system keychain.

If a ngrok api key is provided the ngrok api endpoint method is invoked to obtain the hostport of the tunnel. A list of port forwards is provided to the connect_api function and ports validated to restrict connections to system ports on the remote host to a set of pre-defined ports such as http,https. After establishing a ssh connection to the remote server, local proxy port forwards are opened. If the connection is interrupted then the ssh_connect method will attempt to re-establish the connection.

Example command line usage:

config file, located at:
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

start tunnel with default config, located at ~/.config/ssh_tunnel_proxy/config.json
```
node main.js -c -d

The following code is an example of use of the api with electronjs and needs to be install in main.js, preload.js and the render process.
main.js:
```js

async function init_sshTunnelProxy(win) {

  const SSHTunnelProxy = require('ssh_tunnel_proxy');
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