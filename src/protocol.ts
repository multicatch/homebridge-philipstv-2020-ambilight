
import request, { OptionsWithUrl } from 'request';
import wol from 'wakeonlan';
import { Log } from './logger';

export interface HttpClientConfig {
  api_url: string;
  api_timeout: number;
  api_auth?: HttpClientAuthConfig;
}

export interface HttpClientAuthConfig {
  username: string;
  password: string;
}

export class HttpClient {
  constructor(
    private readonly config: HttpClientConfig,
    private readonly log: Log,
  ) { }

  fetchAPI<T>(endpoint: string, method: string = 'GET', requestBody?: object): Promise<T> {
    return this.fetch(this.config.api_url + endpoint, method, requestBody);
  }

  fetch<T>(url: string, method: string = 'GET', requestBody?: object): Promise<T> {
    const timeout = this.config.api_timeout;
    const body = typeof requestBody === 'object' ? JSON.stringify(requestBody) : requestBody;

    const options: OptionsWithUrl = {
      url: url,
      body: body,
      rejectUnauthorized: false,
      timeout: timeout,
      method: method,
      followAllRedirects: true,
    };

    if (this.config.api_auth) {
      options.forever = true;
      options.auth = {
        user: this.config.api_auth.username,
        pass: this.config.api_auth.password,
        sendImmediately: false,
      };
    }

    return new Promise((success, fail) => {
      this.log.debug('[%s %s] Request to TV: %s', method, url, requestBody);
      try {
        request(options, (error, _response, body) => {
          if (error) {
            this.log.debug('[%s %s] Request error %s', method, url, error);
            fail(error);
          } else {
            this.log.debug('[%s %s] Response from TV %s', method, url, body);
            if (body && (body.indexOf('{') !== -1 || body.indexOf('[') !== -1)) {
              try {
                success(JSON.parse(body));
              } catch (e) {
                fail(e);
              }
            } else {
              success({} as T);
            }
          }
        });
      } catch (e) {
        this.log.debug('[%s %s] Error %s', e);
        fail(e);
      }
    });
  }
}


export class WOLCaster {
  constructor(
    private readonly log: Log,
    private readonly wol_mac?: string,
  ) {
    this.wake = this.wake.bind(this);
  }

  async wake(): Promise<boolean> {
    const mac = this.wol_mac;
    if (!mac) {
      return new Promise(resolve => {
        this.log.debug('WOL not configured');
        resolve(false);
      });
    }

    this.log.debug('Waking up TV with MAC %s', mac);
    try {
      await wol(mac);
      this.log.debug('WOL successful!');
      return true;
    } catch (error) {
      this.log.debug('WOL failed: %s', error);
      throw error;
    }
  }
}