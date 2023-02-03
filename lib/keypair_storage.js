/*

keypair_storage - generate and store keypairs in the system keychain

keypair_storage provides a set of functions to generate ssh ed25519 keypairs. Private keys
are stored in the system keychain and retrieved by service_name and server_name parameters.

Author: Autonomous
First release: 1-29-2023
License: MIT

*/

const sshpk = require('sshpk');
const keytar = require('keytar');

class KeypairStorage {
    constructor() {

    }

    // export function to generate keypair and store under service name and account
    generate_and_store_keypair(service_name, account) {
        const keypair = this.generate_keypair();
        return new Promise((resolve, reject) => {
            keytar.setPassword(service_name, account, keypair.private_key).then(() => {
                resolve(keypair.public_key);
            }, (err) => {
                reject(err);
            });
        });
    }

    // export function to obtain public key from system's keychain stored under service_name and account
    get_public_key_from_keychain(service_name, account) {
        return new Promise((resolve, reject) => {
            keytar.getPassword(service_name, account).then((private_key) => {
                var public_key = this.get_public_key_from_private(private_key);
                resolve(public_key);
            }, (err) => {
                reject(err);
            });
        });
    }

    get_public_key_from_private(private_key) {
        if (private_key) {
            var key = sshpk.parsePrivateKey(private_key, 'pem');
            if (key) return key.toPublic().toString('ssh');
            else return null;
        }
        return null;
    }

    // generate EdDSA keypair
    generate_keypair() {
        // generate private key then obtain public key from private
        // note: EdDSA is required for nodejs ssh
        const privateKey = sshpk.generatePrivateKey('ed25519').toString('ssh');
        const publicKey = this.get_public_key_from_private(privateKey);
        return {
            public_key: publicKey,
            private_key: privateKey
        };
    }
    get_keypair(service, server) {
        return keytar.getPassword(service, server);
    }
    set_keypair(service, server, key) {
        return keytar.setPassword(service, server, key);
    }
    delete_keypair(service, server) {
        return keytar.deletePassword(service, server);
    }
}
module.exports = KeypairStorage;
