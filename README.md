# Flightroute

Offline GPS and flight map for iPhone. (Repository: GPS-tracker.)

Flightroute is a web app that shows your position on a map and keeps working with no signal. It is plain HTML, CSS and JavaScript with no build step.

## What it does

- Shows your live position on an OpenStreetMap-based map as a navigation arrow on the ground and, once airborne, an animated jet with flickering engines and vapour trails; both turn to face your direction of travel
- **Simulate a flight** (Offline map panel): plays a whole flight along the planned journey in about a minute, to test the timer, the jet and landing detection before flying
- **Plan a journey**: enter a flight number (looked up on [adsbdb](https://www.adsbdb.com)) or pick airports from the built-in list of 3,200 airports (works offline) or any place; recent journeys and places are remembered; it saves street maps around both ends and an overview map along the great-circle route, draws the route, and shows the distance still to go
- **Save the area on screen** at Overview (flights, a continent), Region or Street detail
- Zooming in past the saved detail shows the coarser saved map instead of a blank screen
- **Flight timer**: starts automatically once you are 50 m above the ground and moving fast, and stops 30 seconds after you slow down on landing
- **GPS signal** bars and accuracy in the top bar, with a warning when fixes stop arriving; an Offline pill when there is no connection
- **Records flights automatically** (switch in Tracks, on by default): starts at takeoff, including the last 3 minutes on the ground, and saves the track at landing, named after the journey
- Records tracks by hand too (record, pause, stop); a recording in progress is kept on the phone, so it resumes after a reload or app update
- Shows speed, distance, time and altitude, and lists saved tracks
- Exports tracks as GPX (share sheet on iPhone) and imports GPX files
- Installs to the home screen and opens offline. Opening the site in a browser shows a store-style welcome page with **Install** (the browser's own install prompt on Android and desktop Chrome; a three-step guide on iPhone, iPad and Mac Safari, which don't allow one-tap install) and **Web version**

## Using it on iPhone

1. Open the site in Safari while you have a connection and allow location access.
2. Tap **Share → Add to Home Screen**, and open Flightroute from the home screen icon from now on. Home-screen apps keep their stored maps; Safari tabs can have site data cleared after a few weeks of not being used.
3. Before a flight, open **Offline map → Plan a journey**, enter the departure and arrival cities or airports, and tap **Save journey maps** (about 40 MB for London to Malta). To save somewhere else, frame it on screen and use **Save the area on screen**.
4. With no signal, open Flightroute from the home screen: the saved area and your position still show.

On a plane: GPS works in flight mode. Sit by a window for the best fix, and keep the phone plugged in; GPS with the screen on uses a lot of battery.

Limits: iOS stops web apps from reading GPS while the screen is locked or another app is in front, so keep Flightroute open while recording. The app asks to keep the screen awake while recording.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Page markup |
| `app.css` | Styles |
| `app.js` | Map, GPS, recording, offline tiles, GPX |
| `sw.js` | Service worker that keeps the app available offline |
| `manifest.webmanifest`, `icons/` | Home screen install |
| `screenshots/` | Welcome page and install screenshots |
| `airports.json` | Airports with scheduled flights, from [OurAirports](https://ourairports.com/data/) (public domain) |
| `vendor/` | MapLibre GL JS 4.7.1 (BSD-3-Clause, see `vendor/maplibre-LICENSE.txt`) |

## Map data

Map tiles come from [OpenFreeMap](https://openfreemap.org) (free, no key). Place search uses [Photon](https://photon.komoot.io) and only works with a connection. Map data © OpenStreetMap contributors, © OpenMapTiles. The tile set version is pinned on first load so saved areas keep working; **Delete all offline maps** clears saved tiles.

## Running locally

`python3 -m http.server 8000` in this folder, then open `http://localhost:8000`. Location access needs HTTPS or `localhost`.
