import type { API, Characteristic, IndependentPlatformPlugin, Logging, PlatformAccessory, PlatformConfig, Service } from 'homebridge';

import { PhilipsTVAccessory } from './platformAccessory.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';

/**
 * HomebridgePlatform
 * This class is the main constructor for your plugin, this is where you should
 * parse the user config and discover/register accessories with Homebridge.
 */
export class PhilipsTV2020Platform implements IndependentPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  // this is used to track restored cached accessories
  public readonly accessories: Map<string, PlatformAccessory> = new Map();
  public readonly discoveredCacheUUIDs: string[] = [];

  // This is only required when using Custom Services and Characteristics not support by HomeKit
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public readonly CustomServices: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public readonly CustomCharacteristics: any;

  constructor(
    public readonly log: Logging,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    this.log('Config: %s', config);
    // This is only required when using Custom Services and Characteristics not support by HomeKit
    //this.CustomServices = new EveHomeKitTypes(this.api).Services;
    //this.CustomCharacteristics = new EveHomeKitTypes(this.api).Characteristics;

    this.log.debug('Finished initializing platform:', this.config.name);

    // When this event is fired it means Homebridge has restored all cached accessories from disk.
    // Dynamic Platform plugins should only register new accessories after this event was fired,
    // in order to ensure they weren't added to homebridge already. This event can also be used
    // to start discovery of new accessories.
    this.api.on('didFinishLaunching', () => {
      log.debug('Executed didFinishLaunching callback');
      // run the method to discover / register your devices as accessories
      this.discoverDevices();
    });
  }

  /**
   * This function is invoked when homebridge restores cached accessories from disk at startup.
   * It should be used to set up event handlers for characteristics and update respective values.
   */
  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);

    // add the restored accessory to the accessories cache, so we can track if it has already been registered
    this.accessories.set(accessory.UUID, accessory);
  }

  /**
   * This is an example method showing how to register discovered accessories.
   * Accessories must only be registered once, previously created accessories
   * must not be registered again to prevent "duplicate UUID" errors.
   */
  discoverDevices() {
    // EXAMPLE ONLY
    // A real plugin you would discover accessories from the local network, cloud services
    // or a user-defined array in the platform config.
    const devicesInConfig = this.config.tvs || [];

    const deviceAccessories: PlatformAccessory[] = [];

    // loop over the discovered devices and register each one if it has not already been registered
    for (const device of devicesInConfig) {
      
      PhilipsTVAccessory.allUUIDs(this.api, device).forEach(uuid => {
        const existingAccessory = this.accessories.get(uuid);

        if (existingAccessory) {
          // the accessory already exists
          this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);
          this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [existingAccessory]);
        }
      });

      // the accessory does not yet exist, so we need to create it
      this.log.info('Adding new accessory:', device.name);

      // create the accessory handler for the newly create accessory
      // this is imported from `platformAccessory.ts`
      const accessories = new PhilipsTVAccessory(this.api, this.log, this.Characteristic, this.Service, device).getAccessories();

      // link the accessory to your platform
      //this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      accessories.forEach(a => deviceAccessories.push(a));
    }

    this.api.publishExternalAccessories(PLUGIN_NAME, deviceAccessories);
  }
}
