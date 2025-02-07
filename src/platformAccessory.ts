import { Categories, Characteristic, Logger, type PlatformAccessory, type Service } from 'homebridge';

import { HttpClient, WOLCaster } from './protocol.js';
import { Refreshable, TVAmbilightService, TVScreenService, TVService, TVSpeakerService } from './services.js';
import { Log } from './logger.js';

interface PhilipsTVConfig {
  name?: string;
  api_url: string;
  wol_mac?: string,
  wake_up_delay?: number,
  api_auth?: PhilipsApiAuth,
  api_timeout?: number,
  auto_update_interval?: number,
  metadata?: PhilipsTVMetadata,
}

interface PhilipsApiAuth {
  username: string;
  password: string;
}

interface PhilipsTVMetadata {
  model?: string;
  manufacturer?: string;
  serialNumber?: string;
}

/**
 * Philips TV accessory
 */
export class PhilipsTVAccessory {
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
    this.log.debug('Using config: %s', config);
    this.httpClient = new HttpClient(config, this.log);
    this.wolCaster = new WOLCaster(this.log, config.wol_mac, config.wake_up_delay);

    this.accessory.category = Categories.TELEVISION;

    const tvService = new TVService(accessory, this.log, this.httpClient, this.wolCaster, characteristic, serviceType);
    this.refreshables.push(tvService);

    const speakerService = new TVSpeakerService(accessory, this.log, this.httpClient, characteristic, serviceType);
    this.refreshables.push(speakerService);

    const tvScreen = new TVScreenService(accessory, this.log, this.httpClient, characteristic, serviceType);
    tvService.subscribe(tvScreen);
    this.refreshables.push(tvScreen);

    const ambilight = new TVAmbilightService(accessory, this.log, this.httpClient, characteristic, serviceType);
    tvService.subscribe(ambilight);
    this.refreshables.push(ambilight);

    const metadata = config.metadata;
    this.accessory.getService(serviceType.AccessoryInformation)!
      .setCharacteristic(characteristic.Name, config.name || 'Philips TV')
      .setCharacteristic(characteristic.Manufacturer, metadata?.manufacturer || 'Philips')
      .setCharacteristic(characteristic.Model, metadata?.model || 'Generic TV')
      .setCharacteristic(characteristic.SerialNumber, metadata?.serialNumber || config.wol_mac || 'Default-Serial');

    this.refreshData = this.refreshData.bind(this);
    this.refreshData();
    const update_interval = config.auto_update_interval || 0;
    if (update_interval >= 100) {
      setInterval(this.refreshData, update_interval);
    }
  }

  async refreshData() {
    this.log.debug('Performing scheduled auto-refresh.');
    for (const refreshable of this.refreshables) {
      try {
        await refreshable.refreshData();
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

