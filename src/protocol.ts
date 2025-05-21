
import request, { OptionsWithUrl } from 'request';
import wol, { Options } from 'wakeonlan';
import { Log } from './logger.js';
import { delay } from './util.js';

export interface HttpClientConfig {
  api_url: string;
  api_timeout?: number;
  api_auth?: HttpClientAuthConfig;
}

export interface HttpClientAuthConfig {
  username: string;
  password: string;
}

const DEFAULT_TIMEOUT: number = 3_000;

export class HttpClient {
  constructor(
    private readonly config: HttpClientConfig,
    private readonly log: Log,
  ) { }

  fetchAPI<T>(endpoint: string, method: string = 'GET', requestBody?: object): Promise<T> {
    return this.fetch(this.config.api_url + endpoint, method, requestBody);
  }

  fetch<T>(url: string, method: string = 'GET', requestBody?: object): Promise<T> {
    const timeout = this.config.api_timeout || DEFAULT_TIMEOUT;
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

    return this.call<T>(options);
  }

  private async call<T>(options: OptionsWithUrl): Promise<T> {
    return new Promise((success, fail) => {
      this.log.debug('[%s %s] Request to TV: %s', options.method, options.url, options.body);
      try {
        request(options, (error, _response, body) => {
          if (error) {
            this.log.debug('[%s %s] Request error %s', options.method, options.url, error);
            fail(error);
          } else {
            this.log.debug('[%s %s] Response from TV %s', options.method, options.url, body);
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
        }).on('error', e => {
          fail(e);
        });
      } catch (e) {
        this.log.debug('[%s %s] Error %s', options.method, options.url, e);
        fail(e);
      }
    });
  }
}

const DEFAULT_WAKE_UP_DELAY = 4000;

export class WOLCaster {
  private wake_up_delay: number;

  constructor(
    private readonly log: Log,
    private readonly wol_mac?: string,
    wake_up_delay?: number,
    private readonly options?: Options,
  ) {
    this.wake_up_delay = wake_up_delay || DEFAULT_WAKE_UP_DELAY;
  }

  async wakeAndWarmUp(): Promise<boolean> {
    const woken = await this.wake();
    if (woken) {
      this.log.debug('Now waiting %s ms for a warm up...', this.wake_up_delay);
      return delay(this.wake_up_delay).then(() => woken);
    } else {
      return woken;
    }
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
      await wol(mac, this.options);
      this.log.debug('WOL successful!');
      return true;
    } catch (error) {
      this.log.debug('WOL failed: %s', error);
      throw error;
    }
  }
}