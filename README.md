# OMM Web

Configure the onboard memory of Logitech G mice from the browser, using WebHID.
It is an unofficial web take on Logitech's Onboard Memory Manager, written for the
PRO X SUPERLIGHT 2. It is not affiliated with or endorsed by Logitech.

## Running it

There is nothing to build or install. Open `index.html` in a Chromium based desktop
browser (Chrome, Edge, Opera), click "Connect Device" and pick the mouse or its receiver.
Any static file host works too, as long as it serves over HTTPS.

- Close G HUB first. It keeps the device busy and can switch it out of onboard mode.
- `index.html?demo` runs against a simulated mouse, no hardware needed
  (`?demo=6` simulates the other common profile layout).
- Firefox and Safari do not implement WebHID.

## What works

- DPI slots: values, slot count, profile default, DPI shift slot, set current DPI
- Advanced DPI on sensors that support it: separate y-axis, lift off distance
- Button assignments, including the G-Shift layer and recorded keystrokes
- Report rate (wired and wireless where the mouse has both)
- BHOP mode on mice that have it
- Multiple profiles: switch, enable and disable
- Restore factory defaults, revert unsaved edits
- Battery level, host mode warning with a switch back to onboard mode
- Identify button (the mouse buttons do nothing while it waits for a press)

## Not implemented

- Receiver pairing
- Lighting effects
- HITS (analog button) configuration
- The "cycle profiles not enabled across all profiles" warning
- Macros (existing ones are shown as "Macro not supported" and left untouched)

## Layout

- `js/hidpp.js` HID++ 2.0 requests over WebHID
- `js/profile.js` profile sector layouts, checksum, profile directory
- `js/actions.js` button assignment encoding and names
- `js/device.js` mouse model: load, edit, save
- `js/mock.js` simulated mouse for the demo mode
- `js/ui.js` the interface
- `css/style.css` styling

## A word of caution

Saving writes to the mouse's flash memory. The protocol handling follows what the
official tool does, but it has so far only been exercised against the built-in
simulated mouse, not verified on real hardware. If something
looks off after a save, "Restore Defaults" copies the factory profile back.
