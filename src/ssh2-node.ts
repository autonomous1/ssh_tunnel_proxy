/*

ssh2-node: ssh-compatible command line interface to node ssh2

*/

import * as process from 'process';
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { Command } from 'commander';
import { SSHTunnelProxy, SSHConfig, KeypairStorage } from './index';
//import { SSHCredentialList } from '@ngrok/ngrok-api';

function get_default_config() {
  let configs: Array<SSHConfig> = [];
  try {
    configs = JSON.parse(readFileSync(homedir() + '/.config/ssh_tunnel_proxy/config.json').toString());
  } catch (err) {
    console.log('Error loading config file:', err);
  }
  return configs;
}

export function main() {
  const program = new Command();

  program
    .name('ssh2-node')
    .description('Nodejs ssh2 command line client')
    .version('1.2.12')
    //        .option('-2 --protocolv2 [protocolv2]', 'Forces ssh to try protocol version 2 only.')
    .option('-4 --forceIPv4 [forceIPv4]', 'Only connect via resolved IPv4 address for host. Default: false')
    .option('-6 --forceIPv6 [forceIPv6]', 'Only connect via resolved IPv6 address for host. Default: false')
    //        .option('-A --forward_enable [forward_enable]', 'Enables forwarding of the authentication agent connection.')
    //        .option('-a --forward_disable [forward_disable]', 'Disables forwarding of the authentication agent connection.')
    .option('-b --bind [bind]', 'bind_address')
    .option('-C --compress [compress]', 'Requests compression of all data')
    .option('-c --cipher [cipher]', 'cipher_spec')
    .option('-D --dynamic_forward [dynamic_forward]', " Specifies a local 'dynamic' application-level port forwarding.")
    .option('-e --escape [escape]', 'escape_char Sets the escape character for sessions with a pty.')
    .option('-F --config [config]', 'configfile')
    .option('-f --background [background]', 'Requests ssh to go to background just before command execution.')
    .option(
      '-g --local_forward_remote [local_forward_remote]',
      'Allows remote hosts to connect to local forwarded ports.',
    )
    //        .option('-I --smartcard [smartcard]', 'smartcard_device Specify the device ssh.')
    .option('-i --identity [identity]', 'Private key filename.')
    //       .option('-K --gssapi_auth [gssapi_auth]', 'Enables GSSAPI-based authentication and forwarding (delegation) of GSSAPI credentials to the server.')
    //       .option('-k --gssapi_disable [gssapi_disable]', 'Disables forwarding (delegation) of GSSAPI credentials to the server.')
    .option('-L --local_forward_out [local_forward_out...]', 'bind_address:port:host:hostport')
    .option('-l --login_name [login_name]', 'login_name')
    //       .option('-M --master_mode [master_mode]', 'Places the ssh client into \'master\' mode for connection sharing. Multiple -M options')
    //      .option('-m --mac_spec [mac_spec]', 'mac_spec')
    .option('-N --no_exec [no_exec]', 'Do not execute a remote command.')
    .option('-n --redirect_stdin [redirect_stdin]', 'Redirects stdin from /dev/null')
    //        .option('-O --ctl_cmd [ctl_cmd]', 'ctl_cmd')
    .option('-o --option [option]', 'option')
    .option('-p --port [port]', 'port Port to connect to on the remote host.')
    .option('-q --quiet [quiet]', 'Quiet mode. Causes most warning and diagnostic messages to be suppressed.')
    .option('-R --local_forward_in [local_forward_in...]', 'bind_address:port:host:hostport')
    //        .option('-S --ctl_path [ctl_path]', 'ctl_path Specifies the location of a control socket for connection sharing.')
    .option('-s --subsystem [subsystem]', 'May be used to request invocation of a subsystem on the remote system.')
    .option('-T --disable_tty [disable_tty]', 'Disable pseudo-tty allocation.')
    .option('-t --force_tty [force_tty]', 'Force pseudo-tty allocation.')
    .option('-V --version [version]', 'Display the version number and exit.')
    .option('-v --verbose [verbose]', 'Verbose mode. Causes ssh to print debugging messages about its progress.')
    .option(
      '-W --forward_stdin_stdout [forward_stdin_stdout]',
      'host:port Requests that standard input and output on the client be forwarded to host on port ver the secure channel.',
    )
    //        .option('-w --tunnel [tunnel]', 'Requests tunnel device forwarding with the specified tun(4) devices between the client (local_tun) and the server (remote_tun).')
    .option('-X --x11 [x11]', 'Enables X11 forwarding.')
    .option('-x --x11_disable [x11_disable]', 'Disables X11 forwarding.')
    .option('-Y --x11_trusted [x11_trusted]', 'Enables trusted X11 forwarding.')
    .option('-y --log [log]', 'Send log information using the syslog(3)')
    .option('-H --ngrok [ngrok]', 'Obtain connectiion hostport from ngrok')
    .option('-J --keychain_service [keychain_service]', 'Service name to obtain private key from system keychain.')
    .option('-j --keychain_account [keychain_account]', 'Account name to obtain private key from system keychain.')
    .argument('[userhost_arg]', 'Connect to hostname in config.')
    .argument('[exec...]', 'Command to exec on remote host.');

  program.parse(process.argv);
  const opts = program.opts();
  const args = program.processedArgs;
  let username = '';
  let config_host = '';
  let host = '';
  const userhost_arg = `${args[0]}`;
  args.shift();
  const cmd: string = args.join(' ');
  const exec: Array<string> = [];
  if (cmd.length > 0) exec.push(cmd);

  if (userhost_arg) {
    if (userhost_arg.indexOf('@') >= 0) {
      const userhost = userhost_arg.split('@');
      username = userhost[0];
      host = userhost[1];
    } else {
      config_host = userhost_arg;
    }
  } else {
    // error - must specify userhost
    console.log('user@host or host name in config not provided');
    return;
  }

  let configs: Array<SSHConfig> = [];

  // if no config file specified attempt to load default config
  if (config_host) {
    configs = get_default_config();
  } else  {
  // no default config build config from args
  const config: SSHConfig = {
      hostname: 'cli',
      username: username,
      host: host,
      private_key_filename: opts.identity.trim(),
    };
    configs = [config];
  }

  // process each tunnel config in ssh proxy tunnel list
  const keypairStorage = new KeypairStorage();
  let remote_server = '';
  configs.forEach(async (config: SSHConfig) => {
    // skip tunnel if not enabled
    if (config.disabled) return;

    // if remote host specified, only select tunnel for remote host
    if (config_host && config_host !== config.hostname) return;
    remote_server = config_host;

    // if system key storage name specified get key from system keychain
    if (config.service_name) {
      config.server_name = config.hostname || config_host || 'ssh_tunnel_proxy';
      const service_name = config.service_name || 'ssh_client';
      config.private_key = await keypairStorage.get_keypair(service_name, config.server_name);
    }

    // override default config options with command line args
    opts.port && (config.port = opts.port);
    opts.local_forward_out && (config.proxy_ports = opts.local_forward_out);
    opts.local_forward_in && (config.remote_ports = opts.local_forward_in);
    opts.keychain_service && (config.service_name = opts.keychain_service);
    opts.keychain_account && (config.server_name = opts.keychain_account);
    opts.ngrok && (config.ngrok_api = opts.ngrok);
    opts.identity && (config.private_key_filename = opts.identity.trim());
    opts.compress && (config.compress = opts.compress);
    opts.cypher && (config.cypher = opts.cypher);

    // execute command if specified, otherwise enable shell
    if (exec.length > 0) {
      config.exec = exec;
    } else {
      config.shell = true;
    }

    // create new ssh client and start connection
    const sshTunnelProxy = new SSHTunnelProxy();
    sshTunnelProxy.debug_en = opts.verbose;
    await sshTunnelProxy.connectSSH(config, null);

    // if remote commands finished, exit
    if (exec.length > 0) {
      process.exit();
    }
  });

  // issue error if remote host not found in configs
  if (config_host && !remote_server) {
    console.log(`Remote host ${config_host} not found`);
  }
}
