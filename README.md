# GPS-tracker

Off line GPS for iPhone.

Fieldline GPS is a single-page web app that records a GPS track in the browser. Everything lives in `index.html`; there is no build step and no server code.

## Features

- Start, pause and stop recording from the device's location
- Live distance, moving time, speed, average pace, elevation gain and position (degrees-minutes and decimal, with fix accuracy)
- Track plot on a metre grid with scale bar and north arrow
- Saved tracks kept in the browser's local storage
- GPX export and GPX import
- "Simulate a walk" mode for trying the logger without GPS
- Keeps the screen awake while recording where the browser allows it

## Running it

Location access only works on a page served over HTTPS (or `localhost`).

**GitHub Pages:** in the repo go to Settings → Pages, set the source to the `main` branch, root folder. The app will be at `https://robfoy-cloud.github.io/gps-tracker/`. Open it in Safari on the iPhone and allow location access.

**Locally:** `python3 -m http.server 8000` in this folder, then open `http://localhost:8000`.

## Notes

- Tracks are stored per browser. Export to GPX to keep a copy elsewhere.
- Fonts load from Google Fonts; without a connection the page falls back to system fonts.
