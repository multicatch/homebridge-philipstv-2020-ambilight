import { Categories, Characteristic, Logger, type PlatformAccessory, type Service } from 'homebridge';

import { HttpClient, WOLCaster } from './protocol.js';
import { Refreshable, TVService, TVSpeakerService } from './services.js';
import { Log } from './logger.js';

class PhilipsApiAuth {
  constructor(
    readonly username: string,
    readonly password: string,
  ) { }
}

class PhilipsTVMetadata {
  constructor(
    readonly model: string = 'Generic TV',
    readonly manufacturer: string = 'Philips',
    readonly serialNumber: string | undefined,
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
    readonly metadata: PhilipsTVMetadata | undefined,
  ) { }
}

/**
 * Philips TV accessory
 */
export class PhilipsTVAccessory {
  private tvService: TVService;
  private speakerService: TVSpeakerService;
  private refreshables: Refreshable[] = [];

  private log: Log;

  private httpClient: HttpClient;
  private wolCaster: WOLCaster;

  constructor(
    private readonly accessory: PlatformAccessory,
    logger: Logger,
    private readonly characteristic: typeof Characteristic,
    private readonly serviceType: typeof Service,
    config: PhilipsTVConfig,
  ) {
    this.log = new Log(logger, config.name || 'null');
    this.httpClient = new HttpClient(config, this.log);
    this.wolCaster = new WOLCaster(this.log, config.wol_mac);

    this.accessory.category = Categories.TELEVISION;

    this.tvService = new TVService(accessory, this.log, this.httpClient, this.wolCaster, characteristic, serviceType);
    this.refreshables.push(this.tvService);

    this.speakerService = new TVSpeakerService(accessory, this.log, this.httpClient, characteristic, serviceType);
    this.refreshables.push(this.speakerService);

    const metadata = config.metadata;
    this.accessory.getService(serviceType.AccessoryInformation)!
      .setCharacteristic(characteristic.Name, config.name || 'Philips TV')
      .setCharacteristic(characteristic.Manufacturer, metadata?.manufacturer || 'Philips')
      .setCharacteristic(characteristic.Model, metadata?.model || 'Default-Model')
      .setCharacteristic(characteristic.SerialNumber, metadata?.serialNumber || config.wol_mac || 'Default-Serial');

    this.refreshData = this.refreshData.bind(this);
    this.refreshData();
    if (config.auto_update_interval >= 100) {
      setInterval(this.refreshData, config.auto_update_interval);
    }
  }

  async refreshData() {
    this.log.debug('Performing scheduled auto-refresh.');
    for (const refreshable of this.refreshables) {
      try {
        refreshable.refreshData();
      } catch (e) {
        this.log.warn('Error refreshing data about the TV: %s', e);
      }
    }

    try {
      await this.httpClient.fetchAPI('system')
        .then(data => {
          const resp = data as Record<string, Record<string, number>>;
          const apiVersion = resp.api_version;
          return apiVersion.Major + '.' + apiVersion.Minor + '.' + apiVersion.Patch;
        })
        .then(version => {
          this.accessory.getService(this.serviceType.AccessoryInformation)!
            .setCharacteristic(this.characteristic.FirmwareRevision, version || '0.0.0');
        });
    } catch (e) {
      this.log.debug('Cannot update system info. Error: %s', e);
    }
  }

}

