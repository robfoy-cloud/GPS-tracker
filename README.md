# GPS-tracker

Off line GPS for iPhone.

Fieldline GPS is a web app that shows your position on a map and keeps working with no signal. It is plain HTML, CSS and JavaScript with no build step.

## What it does

- Shows your live position as a blue dot with an accuracy circle on an OpenStreetMap-based map
- Saves the map for an area onto the phone (**Offline map → Save this area**) so it still shows with no connection
- Records tracks (record, pause, stop), shows speed, distance, time and accuracy, and lists saved tracks
- Exports tracks as GPX (share sheet on iPhone) and imports GPX files
- Installs to the home screen and opens offline

## Using it on iPhone

1. Open the site in Safari while you have a connection and allow location access.
2. Tap **Share → Add to Home Screen**, and open Fieldline from the home screen icon from now on. Home-screen apps keep their stored maps; Safari tabs can have site data cleared after a few weeks of not being used.
3. Pan and zoom the map to cover the area you want (a town or a small island fits), tap **Offline map → Save this area**.
4. With no signal, open Fieldline from the home screen: the saved area and your position still show.

Limits: iOS stops web apps from reading GPS while the screen is locked or another app is in front, so keep Fieldline open while recording. The app asks to keep the screen awake while recording.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Page markup |
| `app.css` | Styles |
| `app.js` | Map, GPS, recording, offline tiles, GPX |
| `sw.js` | Service worker that keeps the app available offline |
| `manifest.webmanifest`, `icons/` | Home screen install |
| `vendor/` | MapLibre GL JS 4.7.1 (BSD-3-Clause, see `vendor/maplibre-LICENSE.txt`) |

## Map data

Map tiles come from [OpenFreeMap](https://openfreemap.org) (free, no key). Map data © OpenStreetMap contributors, © OpenMapTiles. The tile set version is pinned on first load so saved areas keep working; **Delete all offline maps** clears saved tiles.

## Running locally

`python3 -m http.server 8000` in this folder, then open `http://localhost:8000`. Location access needs HTTPS or `localhost`.
