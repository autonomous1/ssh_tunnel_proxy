# ssh_tunnel_proxy
Initiate a ssh reverse tunnel proxy with forwarding ports

ssh_tunnel_proxy is a wrapper to ssh2 that provides async functionality as well as an extension to the api to include methods to setup a list of proxy forwards, exec a list of commands or startup a terminal shell. To setup a ssh tunnel, parameters are suppled for host, port, authentication and a list of proxy ports or commands to invoke. If a ngrok api key is provided the host and port of the ngrok tunnel are obtained. If the connection is interrupted or connection errors occur, attempts are made re-establish the tunnel.

In addition to the node api, a command line function called ssh-node2 is included to start ssh sessions in a manner similar to the ssh command line utility.

### Command line examples

Initialize ssh2 command:
```
npm i ssh_tunnel_proxy -g
```
Connect to remote host and establish local forwards:

```
ssh2-node -i ~/.ssh/<private_key> -L 8180:192.168.1.1:80 <username>@<hostname>
```

Connect to host with parameters stored in ~/.config/ssh_tunnel_proxy/config.json:

```
ssh2-node rh2
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

Execute command on remote host
```
ssh2-node rh2 "ls -all"
```

### List of command-line options (compatible with original ssh2 command):
```
Usage: ssh2-node [options] [userhost] [exec...]

Nodejs ssh2 command line client

Arguments:
  userhost                                          Connect to hostname in config.
  exec                                              Command to exec on remote host (must be in quotes)

Options:
  -V, --version                                     output the version number
  -2 --protocolv2 [protocolv2]                      Forces ssh to try protocol version 2 only.
  -4 --ipv4only [ipv4only]                          Forces ssh to use IPv4 addresses only.
  -6 --ipv6only [ipv6only]                          Forces ssh to use IPv6 addresses only.
  -A --forward_enable [forward_enable]              Enables forwarding of the authentication agent
                                                    connection.
  -a --forward_disable [forward_disable]            Disables forwarding of the authentication agent
                                                    connection.
  -b --bind [bind]                                  bind_address
  -C --compress [compress]                          Requests compression of all data
  -c --cipher [cipher]                              cipher_spec
  -D --dynamic_forward [dynamic_forward]             Specifies a local 'dynamic' application-level
                                                    port forwarding.
  -e --escape [escape]                              escape_char Sets the escape character for
                                                    sessions with a pty.
  -F --config [config]                              configfile
  -f --background [background]                      Requests ssh to go to background just before
                                                    command execution.
  -g --local_forward_remote [local_forward_remote]  Allows remote hosts to connect to local forwarded
                                                    ports.
  -I --smartcard [smartcard]                        smartcard_device Specify the device ssh.
  -i --identity [identity]                          Private key filename.
  -K --gssapi_auth [gssapi_auth]                    Enables GSSAPI-based authentication and
                                                    forwarding (delegation) of GSSAPI credentials to
                                                    the server.
  -k --gssapi_disable [gssapi_disable]              Disables forwarding (delegation) of GSSAPI
                                                    credentials to the server.
  -L --local_forward_out [local_forward_out...]     bind_address:port:host:hostport
  -l --login_name [login_name]                      login_name
  -M --master_mode [master_mode]                    Places the ssh client into 'master' mode for
                                                    connection sharing. Multiple -M options
  -m --mac_spec [mac_spec]                          mac_spec
  -N --no_exec [no_exec]                            Do not execute a remote command.
  -n --redirect_stdin [redirect_stdin]              Redirects stdin from /dev/null
  -O --ctl_cmd [ctl_cmd]                            ctl_cmd
  -o --option [option]                              option
  -p --port [port]                                  port Port to connect to on the remote host.
  -q --quiet [quiet]                                Quiet mode. Causes most warning and diagnostic
                                                    messages to be suppressed.
  -R --local_forward_in [local_forward_in...]       bind_address:port:host:hostport
  -S --ctl_path [ctl_path]                          ctl_path Specifies the location of a control
                                                    socket for connection sharing.
  -s --subsystem [subsystem]                        May be used to request invocation of a subsystem
                                                    on the remote system.
  -T --disable_tty [disable_tty]                    Disable pseudo-tty allocation.
  -t --force_tty [force_tty]                        Force pseudo-tty allocation.
  -V --version [version]                            Display the version number and exit.
  -v --verbose [verbose]                            Verbose mode. Causes ssh to print debugging
                                                    messages about its progress.
  -W --forward_stdin_stdout [forward_stdin_stdout]  host:port Requests that standard input and output
                                                    on the client be forwarded to host on port ver
                                                    the secure channel.
  -w --tunnel [tunnel]                              Requests tunnel device forwarding with the
                                                    specified tun(4) devices between the client
                                                    (local_tun) and the server (remote_tun).
  -X --x11 [x11]                                    Enables X11 forwarding.
  -x --x11_disable [x11_disable]                    Disables X11 forwarding.
  -Y --x11_trusted [x11_trusted]                    Enables trusted X11 forwarding.
  -y --log [log]                                    Send log information using the syslog(3)
  -H --ngrok [ngrok]                                Obtain connectiion hostport from ngrok
  -J --keychain_service [keychain_service]          Service name to obtain private key from system
                                                    keychain.
  -j --keychain_account [keychain_account]          Account name to obtain private key from system
                                                    keychain.
  -h, --help                                        display help for command
```
### Api examples

Exec remote commands using async await and processing result through streams.

```js
// send result of cmd through pipeline, generating a stream of json objects
function lsTest(cmdProxy, cmd, destination) {

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
                self.toJSONString(),
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
  await lsTest(sshTunnelProxy, 'ls -all', process.stdout);
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