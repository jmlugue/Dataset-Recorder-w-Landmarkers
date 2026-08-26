# Dataset Recorder with Landmarkers

A small browser-based recording tool for collecting gesture dataset videos with live hand landmark overlays. This project is separate from MakaLearn so dataset collection can move quickly without changing the main app.

## What It Does

- Opens the device camera.
- Runs MediaPipe hand landmark detection in the browser.
- Shows a live camera preview with hand landmarks drawn on top.
- Records the preview canvas so the saved video includes the landmark markers.
- Collects recording metadata such as label, participant ID, take number, camera view, and notes.
- Saves a `.webm` video and matching `.json` metadata file through browser download.

## Important Phone Note

Android Chrome can use this recorder when the page is opened through a secure address. For testing from a phone without full hosting, run the app on a laptop and expose it with a temporary HTTPS tunnel.

Example with Cloudflare Tunnel:

```bash
npm run dev -- --host 0.0.0.0
cloudflared tunnel --url http://localhost:5173
```

Open the temporary `https://...trycloudflare.com` link on the Android phone, allow camera access, record, then tap the save buttons. Browser downloads usually go to the phone's Downloads folder. Some Android Gallery apps will also index downloaded videos automatically.

Browsers do not allow silent automatic saving into Gallery/Photos, so the user must confirm or trigger the download.

## Getting Started

```bash
npm install
npm run dev
```

Open:

```txt
http://localhost:5173
```

For laptop testing, `localhost` is enough. For another phone or computer, use HTTPS through a tunnel.

## Scripts

```bash
npm run dev
npm run build
npm run lint
npm run preview
```

## Output Files

The app uses this filename pattern:

```txt
label_participant_take-view_YYYY-MM-DD_HH-MM-SS.webm
label_participant_take-view_YYYY-MM-DD_HH-MM-SS.json
```

The JSON contains:

- recording ID
- label
- participant ID
- take number
- camera view
- notes
- start and end timestamps
- video settings
- detected frame count
- sampled hand landmarks

## Dataset Content Reminder

Use only labels and recordings that your team is allowed to collect and store. This tool does not include official Makaton media or symbol assets.

