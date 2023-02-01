/*

ngrok_service - obtain hostport from ngrok api and split into host, port

Author: Autonomous
First release: 1-29-2023
License: MIT

*/

// get endpoint hostname and hostport from ngrok api
const { Ngrok } = require('@ngrok/ngrok-api');

class NgrokApi {

    constructor(apiToken) {
        this.ngrok = new Ngrok({ apiToken: apiToken });
    }

    get_hostport() {
        const _this = this;
        return new Promise((resolve, reject) => {
            _this.ngrok.endpoints.list()
                .then((endpoints) => {
                    const hostport_obj = _this.parse_ngrok_hostport(endpoints);
                    resolve(hostport_obj);
                }, (err) => {
                    reject(err);
                });
        });
    }

    // retrieve hostport from api response
    parse_ngrok_hostport(endpoints) {
        if (endpoints[0] && endpoints[0].hostport) {
            const hostport = endpoints[0].hostport.split(':');
            var hostport_obj = {
                host: hostport[0],
                port: hostport[1]
            }
            return hostport_obj;
        } else {
            throw (new Error('get_ngrok_hostport: no endpoints found'));
        }
    }
}
module.exports = NgrokApi;
