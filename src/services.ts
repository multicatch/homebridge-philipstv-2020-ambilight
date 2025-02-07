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

function delay(ms: number): Promise<void> {
  return new Promise(res => setTimeout(res, ms));
} 

/** 
 * 
 * TV SERVICE - TV accessory and TV-specific properties
 * 
*/
const POWER_API = 'powerstate';
const KEY_API = 'input/key';

export class TVService implements Refreshable {
  private service: Service;

  private onState = new StateCache<boolean>();

  constructor(
        private readonly accessory: PlatformAccessory,
        private readonly log: Log,
        private readonly httpClient: HttpClient,
        private readonly wolCaster: WOLCaster,
        private readonly characteristic: typeof Characteristic,
        serviceType: typeof Service,
  ) {
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
      this.log.debug('TV is ON, turning off...');
      await this.httpClient.fetchAPI(POWER_API, 'POST', {
        'powerstate': 'Standby',
      });
      this.onState.update(false);

    } else if (!isOn && newState) {
      this.log.debug('TV is OFF, waking up...');
      await this.wolCaster.wake()
        .then(() => delay(100))
        .then(() => this.httpClient.fetchAPI(POWER_API, 'POST', {
          'powerstate': 'On',
        }));
      this.onState.update(true);

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

export class TVSpeakerService implements Refreshable {
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