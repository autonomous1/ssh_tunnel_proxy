# ssh_tunnel_proxy
Initiate a ssh reverse tunnel proxy with forwarding ports

ssh_tunnel_proxy can function as a stand-alone api or part of an electron_js app. To establish a ssh tunnel proxy a keypair is generated on the client and stored in the system keychain.
If a ngrok api key is provided the ngrok api endpoint method is invoked to obtain the hostport of
the tunnel. A list of port forwards is provided to the connect_api function and ports validated to restrict connections to system ports on the remote host to a set of pre-defined ports such as http,https. After establishing a ssh connection to the remote server, local proxy port forwards are opened. If the connection is interrupted then the ssh_connect method will attempt to re-establish the connection.

Example code for electron_js:
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