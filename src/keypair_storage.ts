/*

keypair_storage - generate and store keypairs in the system keychain

keypair_storage provides a set of functions to generate ssh ed25519 keypairs. Private keys
are stored in the system keychain and retrieved by service_name and server_name parameters.

Author: Autonomous
First release: 1-29-2023
License: MIT

*/

import { generatePrivateKey, parsePrivateKey } from 'sshpk';
import * as keytar from 'keytar';

export class KeypairStorage {

  // export function to generate keypair and store under service name and account
  public async generate_and_store_keypair(service_name: string, account: string) {
      try {
          const keypair = this.generate_keypair();
          await keytar.setPassword(service_name, account, keypair.private_key);
          return keypair.public_key;
      } catch(err) {
          console.log('Error storing key:', err);
          throw(err);
      }
  }

  // export function to obtain public key from system's keychain stored under service_name and account
  public async get_public_key_from_keychain(service_name: string, account: string) {
      try {
          const private_key = await keytar.getPassword(service_name, account);
          const public_key = this.get_public_key_from_private(private_key);
          return public_key;
      } catch (err) {
          console.log('Error getting key from keychain:', err);
          throw(err);
      }
  }


  public get_public_key_from_private(private_key: string) {
    if (private_key) {
      try {
        const key = parsePrivateKey(private_key, 'pem');
        if (key) return key.toPublic().toString('ssh');
      } catch (err) {
        //this.debug_en && this.debug('Error parsing private key:', err);  
        console.log('Error parsing private key:', err);  
      }
    }
    return null;
  }

  // generate EdDSA keypair
  generate_keypair() {
    // generate private key then obtain public key from private
    // note: EdDSA is required for nodejs ssh
    const privateKey = generatePrivateKey('ed25519').toString('ssh');
    const publicKey = this.get_public_key_from_private(privateKey);
    return {
      public_key: publicKey,
      private_key: privateKey,
    };
  }
  get_keypair(service: string, server: string) {
    return keytar.getPassword(service, server);
  }
  set_keypair(service: string, server: string, key: string) {
    return keytar.setPassword(service, server, key);
  }
  delete_keypair(service: string, server: string) {
    return keytar.deletePassword(service, server);
  }
}
