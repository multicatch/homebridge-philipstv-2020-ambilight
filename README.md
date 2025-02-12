# Philips TV ver 6 with Ambilight - Homebridge Plugin

This plugin allows you to expose your **Philips TV with API ver. 6** to HomeKit.

Essentially this makes your Philips TV manufactured since 2016 show in Apple Home. 
And it also allows you to control it via Siri.

## Features:
* turn the TV on/off,
* use your iPhone as a remote,
* turn the screen on/off (useful with OLEDs!),
* control Ambilight (with color selection),
* this plugin also automatically updates the status of the TV, thus you can make automations.

![TV as shown in HomeKit](./doc/homekit_view.jpeg)
![Remote controlling the TV via iPhone](./doc/remote.jpeg)

After configuring the plugin, you need to pair the TV via *Add accessory* > *More*. 

#### Note about controlling TV volume

This plugin allows you to control the TV and its volume. To use your phone as remote, you need to use the iPhone *remote* wigdet (as shown in the second screenshot above).

The *remote* on your iPhone also **allows you to mute the TV** or **control its volume**. To control the volume, open the remote on your iPhone, **and then use the physical volume buttons** of your iPhone.

## Configuration

Just use the Homebrige UI to configure it. But if you prefer JSON config, use this cheat sheet:

```json
    "platforms": [ 
        {
            "tvs": [
                {
                    "name": "Philips TV",
                    "api_url": "https://192.168.1.28:1926/6/",
                    "wol_mac": "F0:A1:B2:C3:D4:E5",
                    "wake_up_delay": 3000,
                    "api_auth": {
                        "username": "ABtvF0czCoW1337",
                        "password": "de5fab111b76aa8180cc51215c9112637aaa1031a18b3130ac81ee2d042218c3"
                    },
                    "api_timeout": 3000,
                    "auto_update_interval": 30000,
                    "custom_color_ambilight": true,
                    "metadata": {
                        "model": "55OLED705/12",
                        "manufacturer": "Philips",
                        "serialNumber": "custom_serial_number(optional)"
                    }
                }
            ],
            "platform": "PhilipsTV2020Platform"
        }
    ]
```

* `name` - your TV needs a name, choose whatever you want,
* `api_url` - full API URL, with protocol (https), IP address, port and API version (/6/),
* `wol_mac` - MAC Address of your TV WiFi; you need this if you want to turn it on,
* `wake_up_delay` - your TV needs to 'warm up' after waking up to actually handle the request that turns it on, it's the time needed for this warm-up,
* `api_auth` - credentials for the API (see next section),
* `api_timeout` - maximum time the plugin will wait for your TV to respond (keep it below 5s),
* `auto_update_interval` - interval of background status checks (this is a check whether your TV is on, it will update the status in Homekit),
* `custom_color_ambilight` - if true then the color of Ambilight will be configurable,
* `metadata` - technical data about your TV (optional).

**Note:** the delay/time unit is *milliseconds*. 30000 means **30 seconds**.


## Credentials for 2016 (and newer?) models with Android TV

As per [this project](https://github.com/suborb/philips_android_tv) the Android TV 2016 models Philips use an authenticated HTTPS [JointSpace](http://jointspace.sourceforge.net/) API version 6.
Every control- or status-call needs [digest authentification](https://en.wikipedia.org/wiki/Digest_access_authentication) which contains of a pre generated username and password. You have to do this once for your TV. We recommend to use the python script [philips\_android\_tv](https://github.com/suborb/philips_android_tv).

Here is an example pairing call for philips\_android\_tv :
```
python ./philips.py --host 192.168.0.12 pair
```

As a fresh alternative for python3 you can use [pylips](https://github.com/eslavnov/pylips#setting-up-pylips):

```
python3 pylips.py
```
Username and password will be located in `settings.ini`

You can then add username and password key in your homebridge config, example:
```json
    "platforms": [ 
        {
            "tvs": [
              {
                "accessory": "PhilipsTV",
                ...
                "api_auth": {
                  "username": "5l6n66UK7PYBVKAU",
                  "password": "de8d0d1911a6d3662540114e1b3a5f29a473cc413bf6b38afb97820facdcb1fb"
                }
              }
            ]
        }
    ]
]
 ```
