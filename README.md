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

## Batch Landmark Extraction (Dataset Builder)

Below the recorder there is a **Dataset Builder** section for turning many existing gesture
videos into landmark data — no camera required. Everything runs in the browser; nothing is
uploaded.

Workflow:

1. **Add file(s)** or **Add folder** (or drag clips onto the drop zone). The filename prefix
   becomes the label, e.g. `eat_001.mov` → `eat`. You can edit the label and the expected hand
   count (auto / 1 / 2) per clip.
2. **Extract landmarks** runs MediaPipe frame-by-frame (at 0.3 confidence, matching the Colab
   notebook). Clips with a real duration are stepped by seeking; no-duration webm (including this
   app's own recordings) falls back to playback sampling.
3. Each clip shows a **detection rate** and two "good for modeling" verdicts:
   - **Table 4 verdict** (manuscript, strict): ≥95% Accept · 90–94% Accept if complete ·
     80–89% Review · <80% Re-record.
   - **Notebook status** (current Colab pipeline): coverage <40% fail · <60% warn · <8 detected
     frames fail · otherwise pass.

Exports (available once clips are extracted):

- **Colab landmark ZIP** — one JSON per clip in the exact notebook schema, laid out
  `<label>/<clip>.json`, plus `qc_report.csv`. Drop it into `handgesturedataset2` and run the
  `dataset.npz` cell directly, skipping extraction.
- **Table 3 CSV** — the manuscript's long format:
  `Recording ID, Gesture Label, Frame No., Hand Type, Landmark No., X, Y, Z`.
- **Overlay videos ZIP** — each clip re-encoded with the landmark skeleton drawn on it
  (real-time per clip, so slower for large batches).

The approved gesture labels are `toilet, eat, drink, help, yes, no, sit`.

## Dataset Content Reminder

Use only labels and recordings that your team is allowed to collect and store. This tool does not include official Makaton media or symbol assets.

