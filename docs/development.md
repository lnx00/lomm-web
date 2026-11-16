# Development

## Running locally

There is nothing to build or install. Open `index.html` in a Chromium based desktop
browser and click "Connect Device". The scripts are plain files, not modules, so
the page works straight from disk. Any static file host works too, as long as it
serves over HTTPS, since WebHID requires a secure context.

Icons come from [Lucide](https://lucide.dev/icons), loaded from jsDelivr in
`index.html` with a pinned version and an integrity hash. To change an icon,
edit the `ICONS` map in `js/ui.js`. If the CDN can't be reached, the page
still works without icons.

## Demo mode

`index.html?demo` runs against a simulated mouse, no hardware needed.

- `?demo` or `?demo=10` uses profile format 10 (separate x and y DPI, no lift off distance)
- `?demo=6` uses profile format 6, the other common layout, which also has lift off distance

## Code layout

- `js/hidpp.js` HID++ 2.0 requests over WebHID
- `js/profile.js` profile sector layouts, checksum, profile directory
- `js/actions.js` button assignment encoding and names
- `js/device.js` mouse model: load, edit, save
- `js/mock.js` simulated mouse for the demo mode
- `js/ui.js` the interface
- `css/style.css` styling

## Known gaps

Besides the features listed in the README as not implemented, the
"cycle profiles not enabled across all profiles" warning from the official tool
is not shown.
