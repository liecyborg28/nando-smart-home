# Device types and how to read them

The authoritative description of any device is `get_device_capabilities`. This file only explains the vocabulary you will meet. A category never tells you what a device supports: always check capabilities.

## Categories in `list_devices`

Each device has `category.kind` (a coarse grouping made by this server) and `category.providerCode` (the provider's own code).

| kind | Typical providerCode | Meaning |
|---|---|---|
| `light` | `dj`, `dd`, `xdd`, `fwd` | Lamps and light strips. Usually a power switch plus brightness or colour. |
| `socket` | `cz`, `pc` | Smart plugs. Power switch, sometimes power/energy readings. |
| `switch` | `kg`, `tdq` | Wall switches. |
| `climate` | `infrared_ac`, `kt` | Air conditioners. `infrared_ac` is controlled through an infrared remote (see below). |
| `sensor` | `wsdcg`, `mcs`, `pir`, `hjjcy` | Read-only sensors (temperature, door contact, motion). Nothing to turn on. |
| `curtain` | `cl`, `clkg` | Curtains and blinds. |
| `camera` | `sp` | Cameras. |
| `remote` | `wnykq` | A universal infrared remote hub. It carries the virtual remotes (like an IR air conditioner) but has no controls of its own. |
| `other` | anything else | Unknown. Read capabilities; do not assume. Door locks (`ms`...) and garage doors fall here and are treated as high impact. |

## Infrared devices (very important for honesty)

Devices with `commandFeedback: "none"` are controlled by infrared signals sent from a hub. There is no way for the system to know whether the appliance received and obeyed the signal. Consequences:

- Control results are always `not_verifiable`. Say "sent, unconfirmed" and ask the user to check physically.
- The "status" you read (`power`, `mode`, `temp`, `wind`) is only the last state the cloud remembers sending, not what the appliance is doing. If the user changed things with the physical remote, it will be stale. Say "terakhir tercatat" (last recorded), not "sekarang".
- The hub itself (`wnykq`) usually has no capabilities. `get_device_capabilities` on it returns `UNSUPPORTED_OPERATION`; that is normal, not a fault. Control the virtual device (the AC), not the hub.

## Reading an infrared air conditioner

Typical writable capabilities and their meaning:

| code | Meaning | Values |
|---|---|---|
| `PowerOn` / `PowerOff` | Power keys. Each is a fixed-value capability: the value must equal the code (`turn_on_device` / `turn_off_device` do this for you). | `"PowerOn"` / `"PowerOff"` |
| `T` | Target temperature in degrees C | whole number, usually 16 to 30 |
| `M` | Mode | 0 cooling, 1 heating, 2 auto, 3 fan only, 4 dry |
| `F` | Fan speed | 0 auto, 1 low, 2 medium, 3 high |

Read-only status mirrors this: `power` ("1" on, "0" off), `mode`, `temp`, `wind`. Values arrive as strings. Some air conditioners do not support every mode or fan speed; if a command is rejected, say that this unit does not support it.

## Standard (non-infrared) devices

Power is usually a boolean capability such as `switch_led`, `switch_1` or `switch` (`turn_on_device` resolves it). A device with several switches (`switch_1`, `switch_2`...) is ambiguous for a plain "turn on": ask which one and use `set_device_property` with that code.

Brightness, colour temperature and similar are `integer` capabilities with `min`, `max`, `step`, and often `scale` (a displayed value is `value / 10^scale`; apply it when you report numbers to the user, send raw values).

## Online / offline

`online: false` means the device cannot be controlled right now (`DEVICE_OFFLINE`). Report that; do not retry in a loop. Offline devices are shown in status results as `online: false`, which is information, not an error.
