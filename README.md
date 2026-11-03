# Flightroute

Offline GPS and flight map for iPhone. (Repository: GPS-tracker.)

Flightroute is a web app that shows your position on a map and keeps working with no signal. It is plain HTML, CSS and JavaScript with no build step.

## What it does

- Shows your live position on an OpenStreetMap-based map as a navigation arrow on the ground and, once airborne, an animated jet with flickering engines and vapour trails; both turn to face your direction of travel
- **Simulate a flight** (Offline map panel): plays a whole flight along the planned journey in about a minute, to test the timer, the jet and landing detection before flying
- **Plan a journey**: enter a flight number (looked up on [adsbdb](https://www.adsbdb.com)) or pick airports from the built-in list of 3,200 airports (works offline) or any place; recent journeys and places are remembered; it saves street maps around both ends and a band of detailed maps about 600 km wide along the great-circle route (real routings rarely stray further), draws the route, and shows the distance still to go
- **Save the area on screen** at Overview (flights, a continent), Region or Street detail
- Zooming in past the saved detail shows the coarser saved map instead of a blank screen
- **Flight timer**: starts automatically once you are 50 m above the ground and moving fast, and stops 30 seconds after you slow down on landing
- **GPS signal** bars and accuracy in the top bar, with a warning when fixes stop arriving; an Offline pill when there is no connection
- **Records flights automatically** (switch in Tracks, on by default): starts at takeoff, including the last 3 minutes on the ground, and saves the track at landing, named after the journey
- Records tracks by hand too (record, pause, stop); a recording in progress is kept on the phone, so it resumes after a reload or app update
- **Data panel**: speed, altitude, distance to go and **estimated arrival** (from the last 5 minutes' ground speed, with descent starting about 3 nm per 1,000 ft and averaging two thirds of cruise speed, plus approach time); heading and accuracy when no journey is planned. Recording distance and time show in the Recording pill
- **Metric or imperial** switch (km · mi) beside the coordinates; applies everywhere including the map scale
- **Replay** any saved or imported track: play/pause, speed (10× to 1200×), scrub, follow; shows speed, altitude, distance flown and clock time
- **Saved tracks as routes**: when planning, a saved or imported track that starts near From and ends near To is used as the route (line, saved maps, distance to go, arrival estimate, simulator); otherwise the shortest path
- Exports tracks as GPX (share sheet on iPhone) and imports GPX files
- **Sign-in** (once switched on): invite-only, with a 6-digit code sent by email and no passwords. Admins manage who can use Flightroute in **Settings › People**. Works offline once signed in. See `supabase/SETUP.md`
- **Route library**: automatically recorded flights are shared (path and heights only, no times, dates or names) to `routes/` in this public repository, listed in `routes/index.json`; the planner uses them as real routes for anyone planning the same trip. Can be turned off in Settings
- **Updates**: a new version downloads in the background and the app shows **Update**; Settings shows the version and has **Check for updates**
- Installs to the home screen and opens offline. Opening the site in a browser shows a store-style welcome page with **Install** (the browser's own install prompt on Android and desktop Chrome; a three-step guide on iPhone, iPad and Mac Safari, which don't allow one-tap install) and **Web version**

## Using it on iPhone

1. Open the site in Safari while you have a connection and allow location access.
2. Tap **Share → Add to Home Screen**, and open Flightroute from the home screen icon from now on. Home-screen apps keep their stored maps; Safari tabs can have site data cleared after a few weeks of not being used.
3. Before a flight, open **Journey → Plan a journey**, enter the departure and arrival cities or airports, and tap **Save journey maps** (about 80 MB for Malta to London). To save somewhere else, frame it on screen and use **Save the area on screen**.
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
| `worker.js`, `wrangler.jsonc`, `.assetsignore` | Cloudflare Worker: serves the app's files, and `/api/tracks`, which adds a shared route to the library through the GitHub API (signed-in, allowed users only) |
| `config.js`, `vendor/supabase.js`, `supabase/` | Sign-in settings, the Supabase client, and the setup guide and SQL |
| `routes/` | The public route library: one GPX per shared flight and `index.json` |
| `manifest.webmanifest`, `icons/` | Home screen install |
| `screenshots/` | Welcome page and install screenshots |
| `airports.json` | Airports with scheduled flights, from [OurAirports](https://ourairports.com/data/) (public domain) |
| `vendor/` | MapLibre GL JS 4.7.1 (BSD-3-Clause, see `vendor/maplibre-LICENSE.txt`) |

## Map data

Map tiles come from [OpenFreeMap](https://openfreemap.org) (free, no key). Place search uses [Photon](https://photon.komoot.io) and only works with a connection. Map data © OpenStreetMap contributors, © OpenMapTiles. The tile set version is pinned on first load so saved areas keep working; **Delete all offline maps** clears saved tiles.

## Running locally

`python3 -m http.server 8000` in this folder, then open `http://localhost:8000`. Location access needs HTTPS or `localhost`.

## Why there's no real-route lookup

A version looked up the path recent flights actually flew from the OpenSky Network. It was removed: OpenSky blocks requests from cloud servers (so a Cloudflare helper can't reach it), doesn't let other websites read its data from the browser, and had no flights at all from Malta. The wider band of saved maps covers typical routings instead, and any saved or imported GPX of the same trip is used as the route.
