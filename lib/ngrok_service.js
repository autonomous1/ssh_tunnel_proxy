/*

ngrok_service - obtain hostport from ngrok api and split into host, port

Author: Autonomous
First release: 1-29-2023
License: MIT

*/

// get endpoint hostname and hostport from ngrok api
const { Ngrok } = require('@ngrok/ngrok-api');

const get_ngrok_hostport = async function (ngrok_api) {
    const ngrok = new Ngrok({ apiToken: ngrok_api });
    var endpoints = await ngrok.endpoints.list();
    return parse_ngrok_hostport(endpoints);
}

// retrieve hostport from api response
const parse_ngrok_hostport = function (endpoints) {
    if (endpoints[0] && endpoints[0].hostport) {
        const hostport = endpoints[0].hostport.split(':');
        var hostport_obj = {
            host:hostport[0],
            port:hostport[1]
        }
    } else {
        throw (new Error('get_ngrok_hostport: no endpoints found'));
    }
    return hostport_obj;
}

module.exports = {
    get_hostport: get_ngrok_hostport
}