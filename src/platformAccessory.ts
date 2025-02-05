import { Categories, type CharacteristicValue, type Logger, type PlatformAccessory, type Service } from 'homebridge';

import type { PhilipsTV2020Platform } from './platform.js';

import request, { OptionsWithUrl } from 'request';
import wol from 'wake_on_lan';

class PhilipsApiAuth {
  constructor(
    readonly username: string,
    readonly password: string,
  ) { }
}

class PhilipsTVConfig {
  constructor(
    readonly api_url: string,
    readonly wol_mac: string | undefined,
    readonly api_auth: PhilipsApiAuth | undefined,
    readonly api_timeout: number = 3_000, // I've tested and there is no need to wait longer than 3s, longer than 3s means the TV is OFF
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
        fail(e);
      }
    });
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

  /**
   * These are just used to create a working example
   * You should implement your own code to track the state of your accessory
   */
  private exampleStates = {
    On: false,
    Brightness: 100,
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

    /**
     * Creating multiple services of the same type.
     *
     * To avoid "Cannot add a Service with the same UUID another Service without also defining a unique 'subtype' property." error,
     * when creating multiple services of the same type, you need to use the following syntax to specify a name and subtype id:
     * this.accessory.getService('NAME') || this.accessory.addService(this.platform.Service.Lightbulb, 'NAME', 'USER_DEFINED_SUBTYPE_ID');
     *
     * The USER_DEFINED_SUBTYPE must be unique to the platform accessory (if you platform exposes multiple accessories, each accessory
     * can use the same subtype id.)
     * /

    // Example: add two "motion sensor" services to the accessory
    const motionSensorOneService = this.accessory.getService('Motion Sensor One Name')
      || this.accessory.addService(this.platform.Service.MotionSensor, 'Motion Sensor One Name', 'YourUniqueIdentifier-1');

    const motionSensorTwoService = this.accessory.getService('Motion Sensor Two Name')
      || this.accessory.addService(this.platform.Service.MotionSensor, 'Motion Sensor Two Name', 'YourUniqueIdentifier-2');

    /**
     * Updating characteristics values asynchronously.
     *
     * Example showing how to update the state of a Characteristic asynchronously instead
     * of using the `on('get')` handlers.
     * Here we change update the motion sensor trigger states on and off every 10 seconds
     * the `updateCharacteristic` method.
     *
     * /
    let motionDetected = false;
    setInterval(() => {
      // EXAMPLE - inverse the trigger
      motionDetected = !motionDetected;

      // push the new value to HomeKit
      motionSensorOneService.updateCharacteristic(this.platform.Characteristic.MotionDetected, motionDetected);
      motionSensorTwoService.updateCharacteristic(this.platform.Characteristic.MotionDetected, !motionDetected);

      this.platform.log.debug('Triggering motionSensorOneService:', motionDetected);
      this.platform.log.debug('Triggering motionSensorTwoService:', !motionDetected);
    }, 10000);
    */
  }

  wake(): Promise<boolean> {
    const mac = this.config.wol_mac;
    if (!mac) {
      return new Promise((success, _) => {
        this.platform.log.debug('WOL not configured');
        success(false);
      });
    }
    return new Promise((success, failure) => {
      wol.wake(mac, error => {
        if (error) {
          this.platform.log.debug('WOL failed: %s', error);
          failure(error);
        } else {
          this.platform.log.debug('WOL successful!');
          success(true);
        }
      });
    });
  }

  /**
   * Handle "SET" requests from HomeKit
   * These are sent when the user changes the state of an accessory, for example, turning on a Light bulb.
   */
  async setOn(value: CharacteristicValue) {
    const url = this.config.api_url + 'powerstate';

    await this.getOn()
      .then(isOn => {
        if (isOn && !value) {
          this.platform.log.debug('TV is ON, turning off...');
          return this.httpClient.fetch(url, 'POST', {
            'powerstate': 'Standby',
          });
        } else if (!isOn && value) {
          this.platform.log.debug('TV is OFF, waking up...');
          return this.wake().then(_ => this.httpClient.fetch(url, 'POST', {
            'powerstate': 'On',
          }));
        } else {
          this.platform.log.debug('Is TV on? %s. Should be on? %s. Nothing to do.', isOn, value);
        }
      });
  }

  /**
   * Handle the "GET" requests from HomeKit
   * These are sent when HomeKit wants to know the current state of the accessory, for example, checking if a Light bulb is on.
   *
   * GET requests should return as fast as possible. A long delay here will result in
   * HomeKit being unresponsive and a bad user experience in general.
   *
   * If your device takes time to respond you should update the status of your device
   * asynchronously instead using the `updateCharacteristic` method instead.
   * In this case, you may decide not to implement `onGet` handlers, which may speed up
   * the responsiveness of your device in the Home app.

   * @example
   * this.service.updateCharacteristic(this.platform.Characteristic.On, true)
   */
  async getOn(): Promise<CharacteristicValue> {
    const url = this.config.api_url + 'powerstate';

    return this.httpClient.fetch(url)
      .then(data => {
        const resp = data as Record<string, string>;
        return resp.powerstate === 'On';
      })
      .catch(e => {
        this.platform.log('Cannot fetch TV power status, is it off?');
        this.platform.log.debug('Error fetching TV status: %s', e);
        return false;
      });
  }

  /**
   * Handle "SET" requests from HomeKit
   * These are sent when the user changes the state of an accessory, for example, changing the Brightness
   */
  async setBrightness(value: CharacteristicValue) {
    // implement your own code to set the brightness
    this.exampleStates.Brightness = value as number;

    this.platform.log.debug('Set Characteristic Brightness -> ', value);
  }
}

