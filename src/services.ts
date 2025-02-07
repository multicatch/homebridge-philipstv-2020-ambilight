import { Characteristic, CharacteristicValue, PlatformAccessory, Service } from 'homebridge';
import { HttpClient, WOLCaster } from './protocol';
import { StateCache } from './cacheable.js';
import { RemoteKey } from 'hap-nodejs/dist/lib/definitions/CharacteristicDefinitions.js';
import { Log } from './logger';

/**
 * UTILS
 */
export interface Refreshable {
    refreshData(): Promise<void>;
}

export interface WantsToBeNotifiedAboutUpdates {
    notify(): void;
}

export class NotifiesOthersAboutUpdates {
  private others: WantsToBeNotifiedAboutUpdates[] = [];

  constructor(protected readonly log: Log) {
  }

  subscribe<T extends WantsToBeNotifiedAboutUpdates>(other: T) {
    this.others.push(other);
  }

  notifyOthers() {
    setTimeout(() => {
      try {
        for (const other of this.others) {
          other.notify();
        }
      } catch (e) {
        this.log.warn('Notification about update failed: %s', e);
      }
    }, 100);
  }
}

/** 
 * 
 * TV SERVICE - TV accessory and TV-specific properties
 * 
*/
const POWER_API = 'powerstate';
const KEY_API = 'input/key';

export class TVService extends NotifiesOthersAboutUpdates implements Refreshable {
  private service: Service;

  private onState = new StateCache<boolean>();

  constructor(
        private readonly accessory: PlatformAccessory,
        log: Log,
        private readonly httpClient: HttpClient,
        private readonly wolCaster: WOLCaster,
        private readonly characteristic: typeof Characteristic,
        serviceType: typeof Service,
  ) {
    super(log);
    this.service = this.accessory.getService(serviceType.Television) || this.accessory.addService(serviceType.Television);

    this.service.getCharacteristic(characteristic.Active)
      .onSet(this.setOn.bind(this))
      .onGet(this.getOn.bind(this));

    this.service.getCharacteristic(characteristic.RemoteKey)
      .onSet(this.sendKey.bind(this));
  }

  async refreshData()  {
    try {
      await this.getOn()
        .then(isOn => {
          this.service.updateCharacteristic(this.characteristic.Active, isOn);
        });
    } catch (e) {
      this.log.debug('Cannot update activity status. Error: %s', e);
    }
  }

  async getOn(): Promise<CharacteristicValue> {
    return await this.onState.getOrUpdate(() =>
      this.httpClient.fetchAPI(POWER_API)
        .then(data => {
          const resp = data as Record<string, string>;
          return resp.powerstate === 'On';
        }).catch(e => {
          this.log.info('Cannot fetch TV power status, is it off?');
          this.log.debug('Error fetching TV status: %s', e);
          return false;
        }), false,
    );
  }

  async setOn(newState: CharacteristicValue) {
    const isOn = await this.getOn();

    if (isOn && !newState) {
      this.onState.update(false);
      this.log.debug('TV is ON, turning off...');
      await this.httpClient.fetchAPI(POWER_API, 'POST', {
        'powerstate': 'Standby',
      }).then(() => {
        this.onState.update(false);
        this.notifyOthers();
      });

    } else if (!isOn && newState) {
      this.onState.update(true);
      this.log.debug('TV is OFF, waking up...');
      await this.wolCaster.wakeAndWarmUp()
        .then(() => this.httpClient.fetchAPI(POWER_API, 'POST', {
          'powerstate': 'On',
        }))
        .then(() => {
          this.onState.update(true);
          this.notifyOthers();
        });

    } else {
      this.log.debug('Is TV on? %s. Should be on? %s. Nothing to do.', isOn, newState);
    }
  }

  async sendKey(keyValue: CharacteristicValue) {
    let rawKey = '';
    switch (keyValue) {
    case RemoteKey.PLAY_PAUSE: {
      rawKey = 'PlayPause';
      break;
    }
    case RemoteKey.BACK: {
      rawKey = 'Back';
      break;
    }
    case RemoteKey.ARROW_UP: {
      rawKey = 'CursorUp';
      break;
    }
    case RemoteKey.ARROW_DOWN: {
      rawKey = 'CursorDown';
      break;
    }
    case RemoteKey.ARROW_LEFT: {
      rawKey = 'CursorLeft';
      break;
    }
    case RemoteKey.ARROW_RIGHT: {
      rawKey = 'CursorRight';
      break;
    }
    case RemoteKey.SELECT: {
      rawKey = 'Confirm';
      break;
    }
    case RemoteKey.EXIT: {
      rawKey = 'Exit';
      break;
    }
    case RemoteKey.INFORMATION: {
      rawKey = 'Info';
      break;
    }
    default: {
      this.log.info('Unknown key pressed: %s', keyValue);
      return;
    }
    }

    await this.sendKeyRaw(rawKey);
  }

  async sendKeyRaw(value: string) {
    await this.httpClient.fetchAPI(KEY_API, 'POST', {
      'key': value,
    });
  }

}


/**
 * 
 * SPEAKER SERVICE - Handling the TV Speaker
 * 
 */
const VOLUME_API = 'audio/volume';

class VolumeState {
  min: number = 0;
  max: number = 60;
  current: number = 3;
  muted: boolean = false;
}

export class TVSpeakerService implements Refreshable, WantsToBeNotifiedAboutUpdates {
  private speakerService: Service;

  private volumeState = new StateCache<VolumeState>();

  constructor(
    private readonly accessory: PlatformAccessory,
    private readonly log: Log,
    private readonly httpClient: HttpClient,
    private readonly characteristic: typeof Characteristic,
    serviceType: typeof Service,
  ) {
    this.speakerService = this.accessory.getService(serviceType.TelevisionSpeaker)
      || this.accessory.addService(serviceType.TelevisionSpeaker);

    this.speakerService.getCharacteristic(characteristic.Mute)
      .onSet(this.setMute.bind(this))
      .onGet(this.getMute.bind(this));

    this.speakerService.addCharacteristic(characteristic.Volume)
      .onSet(this.setVolume.bind(this))
      .onGet(this.getVolume.bind(this));

    this.speakerService.getCharacteristic(characteristic.VolumeSelector)
      .onSet(this.changeVolume.bind(this));
  }

  notify(): void {
    this.volumeState.invalidate();
  }

  async refreshData() {
    try {
      await this.getVolumeState(); // this has updates inside
    } catch (e) {
      this.log.debug('Cannot update volume info. Error: %s', e);
    }
  }

  async getMute(): Promise<CharacteristicValue> {
    return await this.volumeState.getOrUpdate(() =>
      this.getVolumeState(), new VolumeState(),
    ).then(data => data.muted);
  }

  async setMute(newState: CharacteristicValue) {
    const isMuted = await this.getMute();

    if (isMuted !== newState) {
      const volume = this.volumeState.getIfNotExpired() || new VolumeState();
      volume.muted = newState as boolean;

      await this.httpClient.fetchAPI(VOLUME_API, 'POST', volume);
      this.volumeState.update(volume);
    }
  }

  async getVolume(): Promise<CharacteristicValue> {
    return await this.volumeState.getOrUpdate(() =>
      this.getVolumeState(), new VolumeState(),
    ).then(this.calculateCurrentVolume);
  }

  async setVolume(newVolume: CharacteristicValue) {
    await this.getVolume(); // refresh state if needed

    let volume = this.volumeState.getIfNotExpired() || new VolumeState();
    volume = this.updateVolume(volume, newVolume as number);

    await this.httpClient.fetchAPI(VOLUME_API, 'POST', volume);
    this.volumeState.update(volume);
  }

  async changeVolume(down: CharacteristicValue) {
    const volume = await this.getVolumeState();

    if (!down && volume.current < volume.max) {
      volume.current = volume.current + 1;
    } else if (down && volume.current > volume.min) {
      volume.current = volume.current - 1;
    }

    await this.httpClient.fetchAPI(VOLUME_API, 'POST', volume);
    this.volumeState.update(volume);
    this.speakerService.updateCharacteristic(this.characteristic.Volume, this.calculateCurrentVolume(volume));
  }

  async getVolumeState(): Promise<VolumeState> {
    return await this.volumeState.getOrUpdate(() =>
      this.httpClient.fetchAPI<VolumeState>(VOLUME_API), new VolumeState(),
    ).then(volume => {
      this.speakerService.updateCharacteristic(this.characteristic.Mute, volume.muted);
      this.speakerService.updateCharacteristic(this.characteristic.Volume, this.calculateCurrentVolume(volume));
      return volume;
    });
  }

  private calculateCurrentVolume(data: VolumeState): number {
    let maxRange = data.max - data.min;
    if (maxRange <= 0) {
      maxRange = 1;
    }
    return Math.floor((1.0 * (data.current - data.min) / maxRange) * 100);
  };

  private updateVolume(data: VolumeState, value: number) {
    data.current = Math.round(data.min + (data.max - data.min) * (value / 100.0));
    return data;
  }
}


/**
 * 
 * TV Screen On/Off Switch
 * 
 */
const SCREEN_API = 'screenstate';

export class TVScreenService implements Refreshable, WantsToBeNotifiedAboutUpdates {
  private service: Service;
  private onState = new StateCache<boolean>();

  constructor(
    accessory: PlatformAccessory,
    private readonly log: Log,
    private readonly httpClient: HttpClient,
    private readonly characteristic: typeof Characteristic,
    serviceType: typeof Service,
  ) {
    this.service = accessory.addService(serviceType.Switch, 'TV Screen', 'tvscreen');
    this.service.setCharacteristic(characteristic.Name, 'Screen');
    this.service.getCharacteristic(characteristic.On)
      .onGet(this.getOn.bind(this))
      .onSet(this.setOn.bind(this));
  }

  notify(): void {
    this.onState.invalidate();
    this.refreshData();
  }

  async refreshData() {
    try {
      const isOn = await this.getOn();
      this.service.updateCharacteristic(this.characteristic.On, isOn);
    } catch (e) {
      this.log.debug('Cannot fetch screen state, the screen is probably OFF. Error: %s', e);
    }
  }

  async getOn(): Promise<CharacteristicValue> {
    return await this.onState.getOrUpdate(() =>
      this.httpClient.fetchAPI(SCREEN_API)
        .then(data => {
          const resp = data as Record<string, string>;
          return resp.screenstate === 'On';
        }).catch(e => {
          this.log.debug('Error fetching TV screen status: %s', e);
          return false;
        }), false,
    );
  }

  async setOn(newState: CharacteristicValue) {
    const isOn = await this.getOn();
    const shouldBeOn = newState as boolean;

    if (isOn !== shouldBeOn) {
      this.log.debug('Setting screen to %s', shouldBeOn);
      this.onState.update(shouldBeOn);
      await this.httpClient.fetchAPI(SCREEN_API, 'POST', {
        'screenstate': shouldBeOn ? 'On' : 'Off',
      });
      this.onState.update(shouldBeOn);
    }
  }
}


/**
 * 
 * TV Ambilight
 * 
 */
const AMBILIGHT_POWER_API = 'ambilight/power';
const AMBILIGHT_CONFIG_API = 'ambilight/currentconfiguration';
const AMBILIGHT_OFF_STYLE_NAME = 'OFF';

class AmbilightCurrentStyle {
  styleName: string = AMBILIGHT_OFF_STYLE_NAME;
  isExpert: boolean = false;
  menuSetting?: string;
  stringValue?: string;
}
  
const AMBILIGHT_OFF_STYLE = new AmbilightCurrentStyle();

export class TVAmbilightService implements Refreshable, WantsToBeNotifiedAboutUpdates {
  private service: Service;
  private onState = new StateCache<boolean>();
  private style = new StateCache<AmbilightCurrentStyle>(100);
  private lastStyle: AmbilightCurrentStyle = new AmbilightCurrentStyle();

  constructor(
    accessory: PlatformAccessory,
    private readonly log: Log,
    private readonly httpClient: HttpClient,
    private readonly characteristic: typeof Characteristic,
    serviceType: typeof Service,
  ) {
    this.service = accessory.addService(serviceType.Lightbulb, 'TV Ambilight', 'tvambilight');
    this.service.setCharacteristic(characteristic.Name, 'Ambilight');
    this.service.getCharacteristic(characteristic.On)
      .onGet(this.getOn.bind(this))
      .onSet(this.setOn.bind(this));
  }

  notify(): void {
    this.onState.invalidate();
    this.style.invalidate();
    this.refreshData();
  }

  async refreshData() {
    try {
      const isOn = await this.getOn();
      this.service.updateCharacteristic(this.characteristic.On, isOn);
    } catch (e) {
      this.log.debug('Cannot fetch screen state, the screen is probably OFF. Error: %s', e);
    }
  }

  async getOn(): Promise<CharacteristicValue> {
    const currentStyle = await this.getCurrentStyle();
    const isActuallyOn = currentStyle.styleName !== AMBILIGHT_OFF_STYLE_NAME;

    if (isActuallyOn) {
      this.lastStyle = currentStyle;
    }

    return await this.onState.getOrUpdate(() =>
      this.httpClient.fetchAPI(AMBILIGHT_POWER_API)
        .then(data => {
          const resp = data as Record<string, string>;
          return resp.power === 'On' || isActuallyOn;
        }).catch(e => {
          this.log.debug('Error Ambilight status: %s', e);
          return false;
        }), false,
    );
  }

  async setOn(newState: CharacteristicValue) {
    const isOn = await this.getOn();
    const currentStyle = await this.getCurrentStyle();
    const shouldBeOn = newState as boolean;

    const isActuallyOn = !isOn && currentStyle.styleName !== AMBILIGHT_OFF_STYLE_NAME;

    this.onState.update(shouldBeOn);
    this.log.debug('Setting Ambilight power status to %s', shouldBeOn);
    
    if (shouldBeOn) {
      await this.setCurrentStyle(this.lastStyle);
      await this.httpClient.fetchAPI(AMBILIGHT_POWER_API, 'POST', {
        'power': 'On',
      });

    } else {
      if (isActuallyOn) {
        this.lastStyle = currentStyle;
      }
      await this.httpClient.fetchAPI(AMBILIGHT_POWER_API, 'POST', {
        'power': 'Off',
      });
      await this.setCurrentStyle(AMBILIGHT_OFF_STYLE);
    }

    this.onState.update(shouldBeOn);
  }

  async getCurrentStyle(): Promise<AmbilightCurrentStyle> {
    return await this.style.getOrUpdate(() =>
      this.httpClient.fetchAPI<AmbilightCurrentStyle>(AMBILIGHT_CONFIG_API).catch(e => {
        this.log.debug('Ambilight style check fail: %s', e);
        this.style.bumpExpiration();
        return this.style.getIfNotExpired() || new AmbilightCurrentStyle();
      }), new AmbilightCurrentStyle(),
    );
  }

  async setCurrentStyle(currentStyle: AmbilightCurrentStyle) {
    await this.httpClient.fetchAPI(AMBILIGHT_CONFIG_API, 'POST', currentStyle);
  }
}