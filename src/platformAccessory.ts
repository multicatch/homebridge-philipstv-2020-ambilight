import { Categories, type CharacteristicValue, type Logger, type PlatformAccessory, type Service } from 'homebridge';

import type { PhilipsTV2020Platform } from './platform.js';

import request, { OptionsWithUrl } from 'request';
import wol from 'wakeonlan';

class PhilipsApiAuth {
  constructor(
    readonly username: string,
    readonly password: string,
  ) { }
}

class PhilipsTVConfig {
  constructor(
    readonly name: string | undefined,
    readonly api_url: string,
    readonly wol_mac: string | undefined,
    readonly api_auth: PhilipsApiAuth | undefined,
    readonly api_timeout: number = 3_000, // I've tested and there is no need to wait longer than 3s, longer than 3s means the TV is OFF
    readonly auto_update_interval: number = 10_000,
  ) { }
}

class HttpClient {
  constructor(
    private readonly config: PhilipsTVConfig,
    private readonly log: Logger,
  ) { }

  fetch<T>(url: string, method: string = 'GET', requestBody?: object | undefined): Promise<T> {
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

type AsyncSupplier<T> = () => Promise<T>;

class StateCache<T> {
  private state?: T;
  private lastCheck = new Date('2000-01-02');
  private pendingUpdates = 0;

  constructor(
    private readonly cacheTime: number = 5_000,
  ) {
    this.update = this.update.bind(this);
    this.getIfNotExpired = this.getIfNotExpired.bind(this);
    this.lockForUpdate = this.lockForUpdate.bind(this);
    this.release = this.release.bind(this);
    this.getOrUpdate = this.getOrUpdate.bind(this);
  }

  update(newState: T) {
    this.state = newState;
    this.lastCheck = new Date();
  }

  private lockForUpdate(): number {
    const pending = this.pendingUpdates;
    this.pendingUpdates += 1;
    // There MAY be race condition but whatever, it's just smart home.
    // If, for some reason, we allow for two simultaneous updates, then screw it, it's not gonna break anything.
    return pending;
  }

  private release() {
    this.pendingUpdates -= 1;
  }

  async getOrUpdate(supplier: AsyncSupplier<T>, defaultValue: T): Promise<T> {
    const placeInQueue = this.lockForUpdate();

    const value = this.getIfNotExpired();
    if (value) {
      this.release();
      return value;
    }
    if (placeInQueue > 0) {
      this.release();
      return this.state || defaultValue;
    }

    try {
      const newValue = await supplier();
      this.update(newValue);
      return newValue;
    } finally {
      this.release();
    }
  }

  getIfNotExpired(): T | undefined {
    if ((this.lastCheck.getTime() - new Date().getTime()) < this.cacheTime) {
      return this.state || undefined;
    } else {
      return undefined;
    }
  }
}


/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 */
export class PhilipsTVAccessory {
  private service: Service;
  private speakerService: Service;

  private httpClient: HttpClient;

  private state = {
    on: new StateCache<boolean>(),
  };

  constructor(
    private readonly platform: PhilipsTV2020Platform,
    private readonly accessory: PlatformAccessory,
    private readonly config: PhilipsTVConfig,
  ) {
    this.httpClient = new HttpClient(config, platform.log);

    this.wake = this.wake.bind(this);

    this.service = this.accessory.getService(this.platform.Service.Television) || this.accessory.addService(this.platform.Service.Television);
    this.accessory.category = Categories.TELEVISION;

    this.service.getCharacteristic(this.platform.Characteristic.Active)
      .onSet(this.setOn.bind(this))
      .onGet(this.getOn.bind(this));

    this.speakerService = this.accessory.getService(this.platform.Service.TelevisionSpeaker)
      || this.accessory.addService(this.platform.Service.TelevisionSpeaker);


    this.service.setCharacteristic(this.platform.Characteristic.Name, this.config.name || 'Philips TV');

    /*
    // set accessory information
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Default-Manufacturer')
      .setCharacteristic(this.platform.Characteristic.Model, 'Default-Model')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, 'Default-Serial');

    // get the LightBulb service if it exists, otherwise create a new LightBulb service
    // you can create multiple services for each accessory

    
    if (accessory.context.device.CustomService) {
      // This is only required when using Custom Services and Characteristics not support by HomeKit
      this.service = this.accessory.getService(this.platform.CustomServices[accessory.context.device.CustomService]) ||
        this.accessory.addService(this.platform.CustomServices[accessory.context.device.CustomService]);
    } else {
      this.service = this.accessory.getService(this.platform.Service.Lightbulb) || this.accessory.addService(this.platform.Service.Lightbulb);
    }

    // set the service name, this is what is displayed as the default name on the Home app
    // in this example we are using the name we stored in the `accessory.context` in the `discoverDevices` method.
    this.service.setCharacteristic(this.platform.Characteristic.Name, accessory.context.device.exampleDisplayName);

    // each service must implement at-minimum the "required characteristics" for the given service type
    // see https://developers.homebridge.io/#/service/Lightbulb

    // register handlers for the On/Off Characteristic
    this.service.getCharacteristic(this.platform.Characteristic.On)
      .onSet(this.setOn.bind(this)) // SET - bind to the `setOn` method below
      .onGet(this.getOn.bind(this)); // GET - bind to the `getOn` method below

    // register handlers for the Brightness Characteristic
    this.service.getCharacteristic(this.platform.Characteristic.Brightness)
      .onSet(this.setBrightness.bind(this)); // SET - bind to the `setBrightness` method below
    */

    setInterval(() => {
      this.getOn()
        .then(isOn => {
          this.service.updateCharacteristic(this.platform.Characteristic.Active, isOn);
        });
    }, this.config.auto_update_interval);
  }

  async wake(): Promise<boolean> {
    const mac = this.config.wol_mac;
    if (!mac) {
      return new Promise(resolve => {
        this.platform.log.debug('WOL not configured');
        resolve(false);
      });
    }

    this.platform.log.debug('Waking up TV with MAC %s', mac);
    try {
      await wol(mac);
      this.platform.log.debug('WOL successful!');
      return true;
    } catch (error) {
      this.platform.log.debug('WOL failed: %s', error);
      throw error;
    }
  }

  async setOn(newState: CharacteristicValue) {
    const url = this.config.api_url + 'powerstate';

    const isOn = await this.getOn();
    if (isOn && !newState) {
      this.platform.log.debug('TV is ON, turning off...');
      await this.httpClient.fetch(url, 'POST', {
        'powerstate': 'Standby',
      });
      this.state.on.update(false);
    } else if (!isOn && newState) {
      this.platform.log.debug('TV is OFF, waking up...');
      await this.wake().then(() => this.httpClient.fetch(url, 'POST', {
        'powerstate': 'On',
      }));
      this.state.on.update(true);
    } else {
      this.platform.log.debug('Is TV on? %s. Should be on? %s. Nothing to do.', isOn, newState);
    }
  }

  async getOn(): Promise<CharacteristicValue> {
    const url = this.config.api_url + 'powerstate';

    return await this.state.on.getOrUpdate(() =>
      this.httpClient.fetch(url)
        .then(data => {
          const resp = data as Record<string, string>;
          return resp.powerstate === 'On';
        }).catch(e => {
          this.platform.log('Cannot fetch TV power status, is it off?');
          this.platform.log.debug('Error fetching TV status: %s', e);
          return false;
        }), false,
    );
  }
}

