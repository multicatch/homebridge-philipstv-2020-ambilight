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

export abstract class PlatformService implements Refreshable {
  private others: PlatformService[] = [];

  constructor(
    protected readonly log: Log,
    private readonly refreshTimeout: number = 500,
  ) {
  }

  abstract refreshData(): Promise<void>;

  async forceRefresh() {
    await this.refreshData();
  }

  addDependant<T extends PlatformService>(other: T) {
    this.others.push(other);
  }

  refreshDependants() {
    setTimeout(() => {
      try {
        for (const other of this.others) {
          other.forceRefresh();
        }
      } catch (e) {
        this.log.warn('Notification about update failed: %s', e);
      }
    }, this.refreshTimeout);
  }
}

/** 
 * 
 * TV SERVICE - TV accessory and TV-specific properties
 * 
*/
const POWER_API = 'powerstate';
const KEY_API = 'input/key';

export class TVService extends PlatformService {
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
    super(log, 1500);
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
        this.refreshDependants();
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
          this.refreshDependants();
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

export class TVSpeakerService extends PlatformService {
  private speakerService: Service;

  private volumeState = new StateCache<VolumeState>();

  constructor(
    private readonly accessory: PlatformAccessory,
    log: Log,
    private readonly httpClient: HttpClient,
    private readonly characteristic: typeof Characteristic,
    serviceType: typeof Service,
  ) {
    super(log);

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

  async forceRefresh() {
    this.volumeState.invalidate();
    await this.refreshData();
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

      this.refreshDependants();
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
    this.refreshDependants();
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

export class TVScreenService extends PlatformService {
  private service: Service;
  private onState = new StateCache<boolean>();

  constructor(
    accessory: PlatformAccessory,
    log: Log,
    private readonly httpClient: HttpClient,
    private readonly characteristic: typeof Characteristic,
    serviceType: typeof Service,
  ) {
    super(log);

    this.service = accessory.addService(serviceType.Switch, 'TV Screen', 'tvscreen');
    this.service.setCharacteristic(characteristic.Name, 'Screen');
    this.service.getCharacteristic(characteristic.On)
      .onGet(this.getOn.bind(this))
      .onSet(this.setOn.bind(this));
  }

  async forceRefresh() {
    this.onState.invalidate();
    await this.refreshData();
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
      this.refreshDependants();
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
const AMBILIGHT_LOUNGE_LIGHT = 'Lounge light';
const AMBILIGHT_OFF_STYLE_NAME = 'OFF';

class AmbilightCurrentStyle {
  styleName: string = AMBILIGHT_OFF_STYLE_NAME;
  isExpert: boolean = false;
  menuSetting?: string;
  stringValue?: string;
  algorithm?: string;
  colorSettings?: AmbilightColorSettings;
}

class AmbilightColorSettings {
  constructor(
    public readonly color: AmbilightColor,
    public readonly colorDelta: AmbilightColor = new AmbilightColor(0, 0, 0),
    public readonly speed: number = 0,
    public readonly mode?: string,
  ) {}
}

class AmbilightColor {
  constructor(
    public hue: number, // 0 - 360
    public saturation: number, // 0 - 100
    public brightness: number, // 0 - 255
  ) {}
}
  
const AMBILIGHT_OFF_STYLE = new AmbilightCurrentStyle();

export class TVAmbilightService extends PlatformService {
  private service: Service;
  private onState = new StateCache<boolean>();
  private style = new StateCache<AmbilightCurrentStyle>(100);
  private lastStyle: AmbilightCurrentStyle = new AmbilightCurrentStyle();

  private readonly color: AmbilightColor = new AmbilightColor(0, 0, 255);

  constructor(
    accessory: PlatformAccessory,
    log: Log,
    private readonly httpClient: HttpClient,
    private readonly characteristic: typeof Characteristic,
    serviceType: typeof Service,
  ) {
    super(log, 4000);

    this.service = accessory.addService(serviceType.Lightbulb, 'TV Ambilight', 'tvambilight');
    this.service.setCharacteristic(characteristic.Name, 'Ambilight');
    this.service.getCharacteristic(characteristic.On)
      .onGet(this.getOn.bind(this))
      .onSet(this.setOn.bind(this));
  }

  private configureColors() {
    this.service.getCharacteristic(this.characteristic.Brightness)
      .onGet(this.getBrightness.bind(this))
      .onSet(this.setBrightness.bind(this));
    this.service.getCharacteristic(this.characteristic.Hue)
      .onGet(this.getHue.bind(this))
      .onSet(this.setHue.bind(this));
    this.service.getCharacteristic(this.characteristic.Saturation)
      .onGet(this.getSaturation.bind(this))
      .onSet(this.setSaturation.bind(this));
  }

  private removeColors() {
    const brightness = this.service.getCharacteristic(this.characteristic.Brightness);
    if (brightness) {
      this.service.removeCharacteristic(brightness);
    }
    const hue = this.service.getCharacteristic(this.characteristic.Hue);
    if (hue) {
      this.service.removeCharacteristic(hue);
    }
    const saturation = this.service.getCharacteristic(this.characteristic.Saturation);
    if (saturation) {
      this.service.removeCharacteristic(saturation);
    } 
  }

  async forceRefresh() {
    this.onState.invalidate();
    this.style.invalidate();
    await this.refreshData();
  }

  async refreshData() {
    try {
      const isOn = await this.getOn();
      this.service.updateCharacteristic(this.characteristic.On, isOn);

      const color = await this.getCurrentColor();
      this.service.updateCharacteristic(this.characteristic.Brightness, color.brightness / 255.0 * 100);
      this.service.updateCharacteristic(this.characteristic.Hue, color.hue);
      this.service.updateCharacteristic(this.characteristic.Saturation, color.saturation);
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
    const style = await this.style.getOrUpdate(() =>
      this.httpClient.fetchAPI<AmbilightCurrentStyle>(AMBILIGHT_CONFIG_API).catch(e => {
        this.log.debug('Ambilight style check fail: %s', e);
        this.style.bumpExpiration();
        return this.style.getIfNotExpired() || new AmbilightCurrentStyle();
      }), new AmbilightCurrentStyle(),
    );

    if (style.styleName === AMBILIGHT_LOUNGE_LIGHT) {
      this.configureColors();
    } else {
      this.removeColors();
    }

    return style;
  }

  async setCurrentStyle(currentStyle: AmbilightCurrentStyle) {
    this.style.update(currentStyle);
    await this.httpClient.fetchAPI(AMBILIGHT_CONFIG_API, 'POST', currentStyle);
  }

  async getBrightness(): Promise<number> {
    const currentColor = await this.getCurrentColor();
    return currentColor.brightness / 255.0 * 100.0;
  }

  async setBrightness(newBrightness: CharacteristicValue) {
    const actualBrightness = Math.round((newBrightness as number) / 100.0 * 255.0);
    const currentColor = await this.getCurrentColor();
    currentColor.brightness = actualBrightness;
    await this.setCurrentColor(currentColor);
  }

  async getHue(): Promise<number> {
    const currentColor = await this.getCurrentColor();
    return currentColor.hue;
  }

  async setHue(newHue: CharacteristicValue) {
    const actualHue = (newHue as number);
    const currentColor = await this.getCurrentColor();
    currentColor.hue = actualHue;
    await this.setCurrentColor(currentColor);
  }

  async getSaturation(): Promise<number> {
    const currentColor = await this.getCurrentColor();
    return currentColor.saturation;
  }

  async setSaturation(newSaturation: CharacteristicValue) {
    const actualHue = (newSaturation as number);
    const currentColor = await this.getCurrentColor();
    currentColor.saturation = actualHue;
    await this.setCurrentColor(currentColor);
  }

  async getCurrentColor(): Promise<AmbilightColor> {
    return this.color;
  }

  async setCurrentColor(color: AmbilightColor) {
    const style = this.createCustomColor(color);
    this.lastStyle = style;
    await this.setCurrentStyle(style);
    await this.setOn(color.brightness > 0);
  }

  private createCustomColor(color: AmbilightColor): AmbilightCurrentStyle {
    const style = new AmbilightCurrentStyle();
    style.colorSettings = new AmbilightColorSettings(color);
    style.algorithm = 'MANUAL_HUE';
    style.styleName = AMBILIGHT_LOUNGE_LIGHT;
    style.isExpert = true;

    return style;
  }
}