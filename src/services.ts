import { Characteristic, CharacteristicValue, PlatformAccessory, Service } from 'homebridge';
import { HttpClient, WOLCaster } from './protocol';
import { StateCache } from './cacheable.js';
import { Log } from './logger';
import { delay } from './util.js';

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

  addDependant<T extends PlatformService>(other: T) {
    this.others.push(other);
  }

  notifyDependants() {
    setTimeout(() => {
      try {
        for (const other of this.others) {
          other.acknowledge(this);
        }
      } catch (e) {
        this.log.warn('Notification about update failed: %s', e);
      }
    }, this.refreshTimeout);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async acknowledge(updatedService: unknown) {
    await this.refreshData();
  }
}

/** 
 * 
 * TV SERVICE - TV accessory and TV-specific properties
 * 
*/
const POWER_API = 'powerstate';
const KEY_API = 'input/key';

export interface TVActivity {
  name: string,
  launch?: TVActionLaunch,
  channel?: string,
}

const DEFAULT_ACTION = 'android.intent.action.MAIN';

export interface TVActionLaunch {
  intent: TVIntent,
  action?: string,
}

export interface TVIntent {
  component: TVApp,
}

export interface TVApp {
  packageName: string,
  className: string
}

export interface TVChannelActivity {
  channel?: TVChannel;
}

export interface TVChannel {
  preset?: string;
}

const DEFAULT_APP: TVApp = {
  packageName: 'org.droidtv.playtv',
  className: 'org.droidtv.playtv.PlayTvActivity',
};

export class TVService extends PlatformService {
  private service: Service;

  private onState = new StateCache<boolean>();
  private activity = new StateCache<TVApp>();

  constructor(
        private readonly accessory: PlatformAccessory,
        log: Log,
        private readonly httpClient: HttpClient,
        private readonly wolCaster: WOLCaster,
        private readonly characteristic: typeof Characteristic,
        serviceType: typeof Service,
        private readonly keyMapping: Map<number, string>,
        private readonly inputs?: TVActivity[],
        defaultInput?: string,
  ) {
    super(log, 1500);
    this.service = this.accessory.getService(serviceType.Television) || this.accessory.addService(serviceType.Television);

    this.service.getCharacteristic(characteristic.Active)
      .onSet(this.setOn.bind(this))
      .onGet(this.getOn.bind(this));

    this.service.getCharacteristic(characteristic.RemoteKey)
      .onSet(this.sendKey.bind(this));

    if (inputs && inputs.length > 0) {
      log.info('Enabling ActiveIdentifier (%s inputs)', inputs.length);
      this.service.getCharacteristic(characteristic.ActiveIdentifier)
        .onSet(this.setActiveIdentifier.bind(this))
        .onGet(this.getActiveIdentifier.bind(this));

      this.service.addLinkedService(
        this.accessory.addService(serviceType.InputSource, defaultInput ?? 'Unknown', 'input-default')
          .setCharacteristic(characteristic.Identifier, 0)
          .setCharacteristic(characteristic.ConfiguredName, defaultInput ?? 'Unknown')
          .setCharacteristic(characteristic.IsConfigured, characteristic.IsConfigured.CONFIGURED)
          .setCharacteristic(characteristic.InputSourceType, characteristic.InputSourceType.HOME_SCREEN),
      );
      for (let i = 0; i < inputs.length; i++) {
        const input = inputs[i];
        const inputService = this.accessory.addService(serviceType.InputSource, input.name, 'input-' + i);
        inputService
          .setCharacteristic(characteristic.Identifier, i + 1)
          .setCharacteristic(characteristic.ConfiguredName, input.name)
          .setCharacteristic(characteristic.IsConfigured, characteristic.IsConfigured.CONFIGURED)
          .setCharacteristic(characteristic.InputSourceType, input.channel ? characteristic.InputSourceType.OTHER : characteristic.InputSourceType.APPLICATION);
        this.service.addLinkedService(inputService);
      }
    }
  }

  async refreshData()  {
    try {
      const wasOn = this.onState.getStale();
      await this.getOn()
        .then(isOn => {
          this.service.updateCharacteristic(this.characteristic.Active, isOn);
          if (isOn !== wasOn) {
            this.notifyDependants();
          }
          return isOn;
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
        this.notifyDependants();
      });

    } else if (!isOn && newState) {
      this.onState.update(true);
      this.log.debug('TV is OFF, waking up...');
      await this.wolCaster.wakeAndWarmUp()
        .then(() => this.httpClient.fetchAPI(POWER_API, 'POST', {
          'powerstate': 'On',
        }))
        .then(() => delay(100)) // wait for HTTP API to digest powerstate change
        .then(() => {
          this.onState.update(true);
          this.notifyDependants();
        });

    } else {
      this.log.debug('Is TV on? %s. Should be on? %s. Nothing to do.', isOn, newState);
    }
  }

  async sendKey(keyValue: CharacteristicValue) {
    const rawKey = this.keyMapping.get(keyValue as number);
    if (rawKey == null) {
      this.log.info('Unknown key pressed: %s', keyValue);
      return;
    }
    await this.sendKeyRaw(rawKey);
  }

  async sendKeyRaw(value: string) {
    await this.httpClient.fetchAPI(KEY_API, 'POST', {
      'key': value,
    });
  }

  async setActiveIdentifier(newState: CharacteristicValue) {
    if (!this.inputs) {
      this.log.debug('ActiveIdentifier disabled, but I received a request to change it to %s', newState);
      return;
    }

    const i = newState as number - 1;
    if (i >= this.inputs.length) {
      this.log.error('Invalid ActiveIdentifier: %s', i);
      return;
    }
    if (i < 0) {
      return;
    }
    const action = this.inputs[i];
    if (!action) {
      return;
    }

    if (action.channel) {
      await this.sendKeyRaw('WatchTV');
      for (const digit of (action.channel + '').split('')) {
        await this.sendKey('Digit' + digit);
      }
      await this.sendKey('Confirm');
    } else if (action.launch) {
      await this.launch(action.launch);
    }
  }

  async launch(app: TVActionLaunch) {
    if (!app.action) {
      app.action = DEFAULT_ACTION;
    }
    await this.httpClient.fetchAPI('activities/launch', 'POST', app);
  }

  async getActiveIdentifier(): Promise<CharacteristicValue> {
    if (!this.inputs) {
      return 0;
    }

    const isOn = this.onState.getIfNotExpired();
    if (isOn === null || isOn === false) {
      return 0;
    }

    const currentApp = await this.getRunningApp();
    let currentChannel = null;
    if (currentApp.packageName === 'org.droidtv.channels' || currentApp.packageName === 'org.droidtv.playtv') {
      currentChannel = await this.getChannel();
    }

    for (let i = 0; i < this.inputs.length; i++) {
      const entry = this.inputs[i];

      let matches = false;
      if (currentChannel !== null && currentChannel !== undefined) {
        matches = entry.channel === currentChannel;
      } else if (entry.launch) {
        const component = entry.launch.intent.component;
        matches = component.packageName === currentApp.packageName && component.className === currentApp.className;
      }

      if (matches) {
        return i + 1;
      }
    }
    return 0;
  }

  async getChannel(): Promise<string | null> {
    return await this.httpClient.fetchAPI<TVChannelActivity>('activities/tv')
      .then(data => {
        return data.channel?.preset ?? null;
      })
      .catch(e => {
        this.log.debug('Cannot parse channel: %s', e);
        return null;
      });
  }

  async getRunningApp(): Promise<TVApp> {
    return await this.activity.getOrUpdate(() => 
      this.httpClient.fetchAPI('activities/current')
        .then(data => {
          const resp = data as TVIntent;
          return resp.component;
        })
    , DEFAULT_APP);
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

  override async acknowledge() {
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

      this.notifyDependants();
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
    this.notifyDependants();
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
  private service?: Service;
  private onState = new StateCache<boolean>();

  constructor(
    accessory: PlatformAccessory,
    log: Log,
    private readonly httpClient: HttpClient,
    private readonly characteristic: typeof Characteristic,
    serviceType: typeof Service,
    show_switch: boolean,
  ) {
    super(log);

    if (show_switch) {
      this.service = accessory.addService(serviceType.Switch, 'TV Screen', 'tvscreen');
      this.service.setCharacteristic(characteristic.Name, 'Screen');
      this.service.getCharacteristic(characteristic.On)
        .onGet(this.getOn.bind(this))
        .onSet(this.setOn.bind(this));
    }
  }

  override async acknowledge(updatedService: unknown) {
    this.onState.invalidate();
    if (updatedService instanceof TVService) {
      const isTVOn = await updatedService.getOn() as boolean;
      this.onState.update(isTVOn);
    }
    await this.refreshData();
  }

  async refreshData() {
    try {
      const isOn = await this.getOn();
      this.service?.updateCharacteristic(this.characteristic.On, isOn);
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
      this.notifyDependants();
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

export class AmbilightCurrentStyle {
  styleName: string = AMBILIGHT_OFF_STYLE_NAME;
  isExpert: boolean = false;
  menuSetting?: string;
  stringValue?: string;
  algorithm?: string;
  colorSettings?: AmbilightColorSettings;
}

export class AmbilightColorSettings {
  constructor(
    public readonly color: AmbilightColor,
    public readonly colorDelta: AmbilightColor = new AmbilightColor(0, 0, 0),
    public readonly speed: number = 0,
    public readonly mode?: string,
  ) {}
}

export class AmbilightColor {
  constructor(
    public hue: number, // 0 - 255
    public saturation: number, // 0 - 255
    public brightness: number, // 0 - 255
  ) {}
}

function ambilightOffStyle(): AmbilightCurrentStyle {
  return new AmbilightCurrentStyle();
}

export class TVAmbilightService extends PlatformService {
  private service?: Service;
  private colorfulService?: Service;
  private pendingColorUpdates = 0;

  private onState = new StateCache<boolean>();
  private style = new StateCache<AmbilightCurrentStyle>(100);

  private isTVOn: boolean = false;
  private isScreenOn: boolean = false;
  private lastStyleOn: AmbilightCurrentStyle = new AmbilightCurrentStyle();
  private lastStyleOff: AmbilightCurrentStyle = new AmbilightCurrentStyle();

  private readonly color: AmbilightColor = new AmbilightColor(0, 0, 255);

  constructor(
    accessory: PlatformAccessory,
    log: Log,
    private readonly httpClient: HttpClient,
    private readonly characteristic: typeof Characteristic,
    serviceType: typeof Service,
    private readonly wolCaster: WOLCaster,
    configurableAmbilightColors: boolean,
    private readonly defaultOnStyle?: AmbilightCurrentStyle,
    private readonly alwaysUseDefaultOn?: boolean,
    private readonly defaultOffStyle?: AmbilightCurrentStyle,
    private readonly alwaysUseDefaultOff?: boolean,
  ) {
    super(log, 4000);
    log.info('The default Ambilight style for screen ON is: %s. Always use? %s', defaultOnStyle?.styleName, alwaysUseDefaultOn);
    if (defaultOnStyle) {
      this.lastStyleOn = defaultOnStyle;
    }
    log.info('The default Ambilight style for screen OFF is: %s. Always use? %s', defaultOffStyle?.styleName, alwaysUseDefaultOff);
    if (defaultOffStyle) {
      this.lastStyleOff = defaultOffStyle;
    }

    this.acknowledge = this.acknowledge.bind(this);
    this.refreshData = this.refreshData.bind(this);

    if (configurableAmbilightColors) {
      this.configureColors(accessory, characteristic, serviceType);
    } else {
      this.service = accessory.addService(serviceType.Lightbulb, 'TV Ambilight', 'tvambilight');
      this.service.setCharacteristic(characteristic.Name, 'Ambilight');
      this.service.getCharacteristic(characteristic.On)
        .onGet(this.getOn.bind(this))
        .onSet(this.setOn.bind(this));
    }
  }

  private configureColors(
    accessory: PlatformAccessory,
    characteristic: typeof Characteristic,
    serviceType: typeof Service,
  ) {
    this.colorfulService = accessory.addService(serviceType.Lightbulb, 'TV Colorful Ambilight', 'tvcolorfulambilight');
    this.colorfulService.setCharacteristic(characteristic.Name, 'Colorful Ambilight');
    this.colorfulService.getCharacteristic(characteristic.On)
      .onGet(this.getOn.bind(this))
      .onSet(this.setOn.bind(this));
    this.colorfulService.getCharacteristic(this.characteristic.Brightness)
      .onGet(this.getBrightness.bind(this))
      .onSet(this.setBrightness.bind(this));
    this.colorfulService.getCharacteristic(this.characteristic.Hue)
      .onGet(this.getHue.bind(this))
      .onSet(this.setHue.bind(this));
    this.colorfulService.getCharacteristic(this.characteristic.Saturation)
      .onGet(this.getSaturation.bind(this))
      .onSet(this.setSaturation.bind(this));
    
    setInterval(this.flushColorSetting.bind(this), 10_000);
  }

  override async acknowledge(updatedService: unknown) {
    if (updatedService instanceof TVScreenService) {
      this.isScreenOn = await updatedService.getOn() as boolean;
      if (!this.isTVOn && !this.isScreenOn) {
        return; // the Ambilight API is very slow and will report "ON" even after the TV is turned off - so we bail out
      }
    }

    this.onState.invalidate();
    this.style.invalidate();

    if (updatedService instanceof TVService) {
      this.isTVOn = await updatedService.getOn() as boolean;
      this.isScreenOn = this.isTVOn;
      if (!this.isTVOn) {
        this.onState.update(false);
        this.style.update(ambilightOffStyle());
        this.service?.updateCharacteristic(this.characteristic.On, false);
        this.colorfulService?.updateCharacteristic(this.characteristic.On, false);
        return; // unfortunately Ambilight REST service returns ON for a while after turning OFF (is it because of smooth Ambilight animation?)
      }
    }
    await this.refreshData();
  }

  async refreshData() {
    try {
      const isOn = await this.getOn();
      this.service?.updateCharacteristic(this.characteristic.On, isOn);

      const color = this.color;
      if (this.colorfulService) {
        this.colorfulService.updateCharacteristic(this.characteristic.On, isOn);
        this.colorfulService.updateCharacteristic(this.characteristic.Brightness, color.brightness / 255.0 * 100);
        this.colorfulService.updateCharacteristic(this.characteristic.Hue, color.hue / 255.0 * 360);
        this.colorfulService.updateCharacteristic(this.characteristic.Saturation, color.saturation / 255.0 * 100);
      }
    } catch (e) {
      this.log.debug('Cannot fetch Ambilight state, the screen is probably OFF. Error: %s', e);
    }
  }

  async getOn(): Promise<CharacteristicValue> {
    const currentStyle = await this.getCurrentStyle();

    const isActuallyOn = currentStyle?.styleName !== AMBILIGHT_OFF_STYLE_NAME;

    if (isActuallyOn) {
      this.updateLastStyle(currentStyle);
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
      if (!this.isTVOn) {
        await this.wolCaster.wakeAndWarmUp();
      }
      await this.setCurrentStyle(this.getLastStyle());
      await this.httpClient.fetchAPI(AMBILIGHT_POWER_API, 'POST', {
        'power': 'On',
      });

    } else {
      if (isActuallyOn) {
        this.updateLastStyle(currentStyle);
      }
      await this.httpClient.fetchAPI(AMBILIGHT_POWER_API, 'POST', {
        'power': 'Off',
      });
      await this.setCurrentStyle(ambilightOffStyle());
    }

    this.onState.update(shouldBeOn);
    this.service?.updateCharacteristic(this.characteristic.On, shouldBeOn);
    if (this.colorfulService) {
      this.colorfulService.updateCharacteristic(this.characteristic.On, shouldBeOn);
    }
  }

  async getCurrentStyle(): Promise<AmbilightCurrentStyle> {
    const style = await this.style.getOrUpdate(() =>
      this.httpClient.fetchAPI<AmbilightCurrentStyle>(AMBILIGHT_CONFIG_API).catch(e => {
        this.log.debug('Ambilight style check fail, assuming the TV is OFF: %s', e);
        return ambilightOffStyle();
      }), ambilightOffStyle(),
    );

    return style;
  }

  async setCurrentStyle(currentStyle: AmbilightCurrentStyle) {
    this.style.update(currentStyle);
    await this.httpClient.fetchAPI(AMBILIGHT_CONFIG_API, 'POST', currentStyle);
  }

  async getBrightness(): Promise<number> {
    return this.color.brightness / 255.0 * 100.0;
  }

  async setBrightness(newBrightness: CharacteristicValue) {
    const actualBrightness = Math.round((newBrightness as number) / 100.0 * 255.0);
    this.color.brightness = actualBrightness;
    this.pendingColorUpdates++; // force update
    await this.setCurrentColor(this.color);
  }

  async getHue(): Promise<number> {
    return this.color.hue / 255.0 * 360.0;
  }

  async setHue(newHue: CharacteristicValue) {
    const actualHue = Math.round((newHue as number) / 360.0 * 255.0);
    this.color.hue = actualHue;
    this.log.debug('Ambilight hue: %s', newHue);
    this.setCurrentColor(this.color);
  }

  async getSaturation(): Promise<number> {
    return this.color.saturation / 255.0 * 100.0;
  }

  async setSaturation(newSaturation: CharacteristicValue) {
    const actualSaturation = Math.round((newSaturation as number) / 100.0 * 255.0);
    this.color.saturation = actualSaturation;
    this.log.debug('Ambilight saturation: %s', newSaturation);
    this.setCurrentColor(this.color);
  }

  private async flushColorSetting() {
    try {
      const color = this.color;
      const pendingUpdates = this.pendingColorUpdates;
      if (pendingUpdates <= 0) {
        return;
      }
      this.pendingColorUpdates += 2;
      await this.setCurrentColor(color);
      this.pendingColorUpdates = 0;
    } catch(e) {
      this.log.warn('Error during Ambilight color update: %s', e);
    }
  }

  private async setCurrentColor(color: AmbilightColor) {
    const pendingUpdates = ++this.pendingColorUpdates;
    await delay(pendingUpdates * 10); // prevent race condition
    if (pendingUpdates <= 2) {
      return;
    }
    this.pendingColorUpdates = 0;

    this.log.debug('Setting Ambilight color style: %s', color);
    const style = this.createCustomColor(color);
    this.updateLastStyle(style);
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

  private updateLastStyle(style: AmbilightCurrentStyle) {
    if (this.isScreenOn) {
      this.lastStyleOn = style;
    } else {
      this.lastStyleOff = style;
    }
  }

  private getLastStyle() {
    if (this.isScreenOn) {
      if (this.alwaysUseDefaultOn && this.defaultOnStyle) {
        return this.defaultOnStyle;
      } else {
        return this.lastStyleOn;
      }
    } else {
      if (this.alwaysUseDefaultOff && this.defaultOffStyle) {
        return this.defaultOffStyle;
      } else {
        return this.lastStyleOff;
      }
    }
  }
}