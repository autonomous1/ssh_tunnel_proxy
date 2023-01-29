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

// export function to generate keypair and store under service name and account
const generate_and_store_keypair = (service_name, account) => {
    const keypair = generate_keypair();
    return new Promise((resolve, reject) => {
        keytar.setPassword(service_name, account, keypair.private_key).then((result)=>{
            resolve(keypair.public_key);
        }, (err) => {
            reject(err);
        });
    });
}

// export function to obtain public key from system's keychain stored under service_name and account
const get_public_key_from_keychain = (service_name, account) => {
    return new Promise((resolve, reject) => {
        keytar.getPassword(service_name, account).then((private_key) => {
            var public_key = get_public_key_from_private(private_key);
            resolve(public_key);
        }, (err) => {
            reject(err);
        });
    });
}

const get_public_key_from_private = (private_key) => {
    if (private_key) {
        var key = sshpk.parsePrivateKey(private_key, 'pem');
        if (key) return key.toPublic().toString('ssh');
        else return null;
    }
    return null;
}

// generate EdDSA keypair
const generate_keypair = () => {
    // generate private key then obtain public key from private
    // note: EdDSA is required for nodejs ssh
    const privateKey = sshpk.generatePrivateKey('ed25519').toString('ssh');
    const publicKey = get_public_key_from_private(privateKey);
    return {
        public_key: publicKey,
        private_key: privateKey
    };
}

module.exports = {
    store_private_key: keytar.setPassword,
    retrieve_private_key: keytar.getPassword,
    remove_keypair: keytar.deletePassword,
    generate_keypair: generate_keypair,
    generate_and_store_keypair: generate_and_store_keypair,
    get_public_key_from_keychain: get_public_key_from_keychain
}
