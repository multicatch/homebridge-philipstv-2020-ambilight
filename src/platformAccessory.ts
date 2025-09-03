import { API, Categories, Characteristic, Logger, type PlatformAccessory, type Service } from 'homebridge';

import { HttpClient, WOLCaster } from './protocol.js';
import { AmbilightCurrentStyle, Refreshable, TVActivity, TVAmbilightService, TVScreenService, TVService, TVSpeakerService } from './services.js';
import { Log } from './logger.js';
import { Options } from 'wakeonlan';

interface PhilipsTVConfig {
  name: string;
  api_url: string;
  wol_mac?: string;
  wol_options?: Options;
  wake_up_delay?: number;
  api_auth?: PhilipsApiAuth;
  api_timeout?: number;
  auto_update_interval?: number
  metadata?: PhilipsTVMetadata;
  key_mapping?: KeyMapping[];
  ambilight_mode?: AmbilightMode;
  ambilight_options?: AmbilightOptions;
  ungroup_accessories?: boolean;
  screen_switch?: boolean;
  inputs?: TVActivity[];
  default_input?: string;
}

export enum AmbilightMode {
  Disabled = 'disabled',
  OnOff = 'on_off',
  Colorful = 'colorful',
}

interface KeyMapping {
  remote_key: string,
  philips_key: string,
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

interface AmbilightOptions {
  default_on_style?: AmbilightCurrentStyle;
  always_use_default_on?: boolean;
  default_off_style?: AmbilightCurrentStyle;
  always_use_default_off?: boolean;
}

/**
 * Philips TV accessory
 */
export class PhilipsTVAccessory {
  private refreshables: Refreshable[] = [];

  private log: Log;

  private httpClient: HttpClient;
  private wolCaster: WOLCaster;

  private readonly accessory: PlatformAccessory;
  private readonly accessories: PlatformAccessory[] = [];

  constructor(
    api: API,
    logger: Logger,
    private readonly characteristic: typeof Characteristic,
    private readonly serviceType: typeof Service,
    config: PhilipsTVConfig,
  ) {
    this.log = new Log(logger, config.name || 'null');
    this.log.debug('Using config: %s', config);
    this.httpClient = new HttpClient(config, this.log);
    this.wolCaster = new WOLCaster(this.log, config.wol_mac, config.wake_up_delay, config.wol_options);

    this.accessory = new api.platformAccessory(config.name, PhilipsTVAccessory.tvUUID(api, config));
    this.accessory.context.device = config;

    this.accessory.category = Categories.TELEVISION;
    this.accessories.push(this.accessory);

    const keyMapping = this.prepareRemoteKeyMapping(config.key_mapping);
    
    const tvService = new TVService(
      this.accessory, this.log, this.httpClient, this.wolCaster, characteristic, serviceType, keyMapping, config.inputs, config.default_input,
    );
    this.refreshables.push(tvService);
    
    const speakerService = new TVSpeakerService(this.accessory, this.log, this.httpClient, characteristic, serviceType);
    this.refreshables.push(speakerService);
    
    const tvScreen = this.setupTVScreen(api, this.accessory, characteristic, serviceType, tvService, config);
    this.setupAmbilight(api, this.accessory, characteristic, serviceType, tvService, tvScreen, config);
    
    const metadata = config.metadata;
    this.accessory.getService(serviceType.AccessoryInformation)!
      .setCharacteristic(characteristic.Name, config.name || 'Philips TV')
      .setCharacteristic(characteristic.Manufacturer, metadata?.manufacturer || 'Philips')
      .setCharacteristic(characteristic.Model, metadata?.model || 'Generic TV')
      .setCharacteristic(characteristic.SerialNumber, metadata?.serialNumber || config.wol_mac || 'Default-Serial');

    this.configureAutoUpdate(config);
  }

  static allUUIDs(api: API, config: PhilipsTVConfig): string[] {
    return [
      this.tvUUID(api, config),
      this.tvScreenUUID(api, config),
      this.ambilightUUID(api, config),
    ];
  }

  static tvUUID(api: API, config: PhilipsTVConfig): string {
    return api.hap.uuid.generate(config.api_url);
  }
  
  static tvScreenUUID(api: API, config: PhilipsTVConfig): string {
    return api.hap.uuid.generate(this.tvUUID(api, config) + '_tvscreeen');
  }

  static ambilightUUID(api: API, config: PhilipsTVConfig): string {
    return api.hap.uuid.generate(this.tvUUID(api, config) + '_ambilight');
  }

  getAccessories(): PlatformAccessory[] {
    return this.accessories;
  }

  private setupTVScreen(api: API, accessory: PlatformAccessory, 
    characteristic: typeof Characteristic,
    serviceType: typeof Service,
    tvService: TVService, 
    config: PhilipsTVConfig,
  ): TVScreenService {
    const ungroupAccessories = config.ungroup_accessories === true;
    const showSwitch = config.screen_switch ?? true;
    let tvScreenAccessory: PlatformAccessory;
    if (ungroupAccessories && showSwitch) {
      tvScreenAccessory = new api.platformAccessory(accessory.displayName + ' Screen', PhilipsTVAccessory.tvScreenUUID(api, config));
      tvScreenAccessory.category = Categories.SWITCH;
      this.accessories.push(tvScreenAccessory);
    } else {
      tvScreenAccessory = accessory;
    }
    const tvScreen = new TVScreenService(tvScreenAccessory, this.log, this.httpClient, characteristic, serviceType, showSwitch);
    tvService.addDependant(tvScreen);
    this.refreshables.push(tvScreen);

    return tvScreen;
  }

  private setupAmbilight(api: API, 
    accessory: PlatformAccessory, 
    characteristic: typeof Characteristic, 
    serviceType: typeof Service, 
    tvService: TVService, 
    tvScreen: TVScreenService, 
    config: PhilipsTVConfig,
  ) {
    this.log.info('Ambilight mode: %s', config.ambilight_mode);
    if (config.ambilight_mode === AmbilightMode.Disabled) {
      return;
    }

    const ungroupAccessories = config.ungroup_accessories === true;
    let ambilightAccessory: PlatformAccessory;
    if (ungroupAccessories) {
      ambilightAccessory = new api.platformAccessory(accessory.displayName + ' Ambilight', PhilipsTVAccessory.ambilightUUID(api, config));
      ambilightAccessory.category = Categories.LIGHTBULB;
      this.accessories.push(ambilightAccessory);
    } else {
      ambilightAccessory = accessory;
    }
    const ambilightWithColors = config.ambilight_mode === AmbilightMode.Colorful;
    const ambilight = new TVAmbilightService(ambilightAccessory, this.log, this.httpClient, characteristic, serviceType, this.wolCaster, ambilightWithColors, 
      config.ambilight_options?.default_on_style, config.ambilight_options?.always_use_default_on === true,
      config.ambilight_options?.default_off_style, config.ambilight_options?.always_use_default_off === true,
    );
    tvService.addDependant(ambilight);
    tvScreen.addDependant(ambilight);
    this.refreshables.push(ambilight);
    return ambilight;
  }

  private configureAutoUpdate(config: PhilipsTVConfig) {
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

  prepareRemoteKeyMapping(mappings?: KeyMapping[]): Map<number, string> {
    const result = new Map<number, string>();
    result.set(this.characteristic.RemoteKey.PLAY_PAUSE, 'PlayPause');
    result.set(this.characteristic.RemoteKey.BACK, 'Back');
    result.set(this.characteristic.RemoteKey.ARROW_UP, 'CursorUp');
    result.set(this.characteristic.RemoteKey.ARROW_DOWN, 'CursorDown');
    result.set(this.characteristic.RemoteKey.ARROW_LEFT, 'CursorLeft');
    result.set(this.characteristic.RemoteKey.ARROW_RIGHT, 'CursorRight');
    result.set(this.characteristic.RemoteKey.SELECT, 'Confirm');
    result.set(this.characteristic.RemoteKey.EXIT, 'Exit');
    result.set(this.characteristic.RemoteKey.INFORMATION, 'Info');
    if (mappings === undefined) {
      return result;
    }

    type RemoteKeyName = keyof typeof this.characteristic.RemoteKey;
    for (const mapping of mappings) {
      const mappedKey = this.characteristic.RemoteKey[mapping.remote_key as RemoteKeyName];
      if (!mappedKey || typeof mappedKey !== 'number') {
        this.log.error('RemoteKey from key_mapping is invalid: %s', mapping.remote_key);
      } else {
        const key = mappedKey as number;
        this.log.info('Overriding key %s (%s) to %s', mapping.remote_key, key, mapping.philips_key);
        result.set(key, mapping.philips_key);
      }
    }
    return result;
  }
}

