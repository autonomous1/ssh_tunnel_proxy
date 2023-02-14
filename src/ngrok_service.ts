/*

ngrok_service - obtain hostport from ngrok api and split into host, port

Author: Autonomous
First release: 1-29-2023
License: MIT

*/

// get endpoint hostname and hostport from ngrok api
import { Ngrok, NgrokConfig } from '@ngrok/ngrok-api';

export type Hostport = {
  host: string;
  port: string;
};

export class NgrokApi {
  ngrok: Ngrok;

  constructor(apiToken) {
    const config: NgrokConfig = {
      apiToken: apiToken,
      baseUrl: undefined,
    };
    this.ngrok = new Ngrok(config);
  }

  get_hostport<Hostport>() {
    return new Promise<Hostport>((resolve, reject) => {
      this.ngrok.endpoints.list().then(
        (endpoints) => {
          const hostport_obj = <Hostport>this.parse_ngrok_hostport(endpoints);
          resolve(hostport_obj);
        },
        (err) => {
          reject(err);
        },
      );
    });
  }

  // retrieve hostport from api response
  parse_ngrok_hostport<Hostport>(endpoints) {
    if (endpoints[0] && endpoints[0].hostport) {
      const hostport = endpoints[0].hostport.split(':');
      const hostport_obj = <Hostport>{
        host: hostport[0],
        port: hostport[1],
      };
      return hostport_obj;
    } else {
      throw new Error('get_ngrok_hostport: no endpoints found');
    }
  }
}
