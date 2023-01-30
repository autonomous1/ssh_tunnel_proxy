# ssh_tunnel_proxy
Initiate a ssh reverse tunnel proxy with forwarding ports

ssh_tunnel_proxy can function as a stand-alone api or part of an electron_js app. To establish a ssh tunnel proxy a keypair is generated on the client and stored in the system keychain.
If a ngrok api key is provided the ngrok api endpoint method is invoked to obtain the hostport of
the tunnel. A list of port forwards is provided to the connect_api function and ports validated to
restrict connections to system ports on the remote host to a set of pre-defined ports such as http,https.
After establishing a ssh connection to the remote server, local proxy port forwards are opened. If
the connection is interrupted then the ssh_connect method will attempt to re-establish the connection.

