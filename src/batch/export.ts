import { strToU8, zip } from "fflate";
import type { DrawingUtils } from "@mediapipe/tasks-vision";
import type { HandLandmarker } from "@mediapipe/tasks-vision";
import { downloadBlob } from "../file-utils";
import { drawHandLandmarks, drawVideoFrame, type HandConnection } from "../draw";
import { loadVision } from "../landmarker";
import { getBestSupportedMimeType } from "../media";
import type { NotebookClipRecord, UploadedClip } from "../types";
import { clipNameFromFilename, waitForVideoEvent, type MonotonicClock } from "./extract";
import { table4Label } from "./qc";

const OVERLAY_FPS = 30;

function zipAsync(files: Record<string, Uint8Array>): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    zip(files, { level: 6 }, (error, data) => (error ? reject(error) : resolve(data)));
  });
}

function csvCell(value: string | number): string {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

// Ensure each clip lands on a unique path inside the ZIP even if names collide.
function uniquePath(used: Set<string>, path: string): string {
  if (!used.has(path)) {
    used.add(path);
    return path;
  }
  const dot = path.lastIndexOf(".");
  const stem = dot === -1 ? path : path.slice(0, dot);
  const ext = dot === -1 ? "" : path.slice(dot);
  let index = 2;
  let candidate = `${stem}-${index}${ext}`;
  while (used.has(candidate)) {
    index += 1;
    candidate = `${stem}-${index}${ext}`;
  }
  used.add(candidate);
  return candidate;
}

function readyClips(clips: UploadedClip[]): UploadedClip[] {
  return clips.filter((clip) => clip.extraction && clip.qc);
}

// A per-clip record in the exact shape the Colab notebook writes (handedness is an extra
// field the notebook ignores), so the ZIP is drop-in for the dataset.npz cell.
export function buildClipRecord(clip: UploadedClip): NotebookClipRecord {
  const extraction = clip.extraction!;
  const qc = clip.qc!;
  return {
    label: clip.label,
    clip: clipNameFromFilename(clip.fileName),
    source: clip.fileName,
    fps: Number(extraction.fps.toFixed(2)),
    frameCount: qc.frameCount,
    detectedFrameCount: qc.anyHandFrameCount,
    coverage: Number(qc.coverage.toFixed(3)),
    status: qc.notebookStatus,
    model: "MediaPipe hand_landmarker.task",
    maxHands: 2,
    frameSamples: extraction.frames
  };
}

// qc_report.csv: the notebook's 7 columns first (drop-in), then the manuscript Table 4 figures.
export function buildQcReportCsv(clips: UploadedClip[]): string {
  const header = [
    "label",
    "clip",
    "status",
    "reason",
    "frames",
    "detected",
    "coverage",
    "detectionRate",
    "table4Verdict"
  ];
  const rows = [header.join(",")];
  for (const clip of readyClips(clips)) {
    const qc = clip.qc!;
    rows.push(
      [
        csvCell(clip.label),
        csvCell(clipNameFromFilename(clip.fileName)),
        csvCell(qc.notebookStatus),
        csvCell(qc.notebookReason),
        qc.frameCount,
        qc.anyHandFrameCount,
        qc.coverage.toFixed(3),
        qc.detectionRate.toFixed(3),
        csvCell(table4Label[qc.table4])
      ].join(",")
    );
  }
  return rows.join("\n");
}

// Manuscript Table 3 long format: one row per landmark of every detected hand in every frame.
export function buildTable3Csv(clips: UploadedClip[]): string {
  const rows = ["Recording ID,Gesture Label,Frame No.,Hand Type,Landmark No.,X,Y,Z"];
  for (const clip of readyClips(clips)) {
    const recordingId = clipNameFromFilename(clip.fileName);
    const label = clip.label;
    clip.extraction!.frames.forEach((frame, frameIndex) => {
      frame.hands.forEach((hand, handIndex) => {
        const handType = frame.handedness[handIndex] ?? "Unknown";
        hand.forEach((point, landmarkIndex) => {
          rows.push(
            [
              csvCell(recordingId),
              csvCell(label),
              frameIndex + 1,
              handType,
              landmarkIndex,
              point.x,
              point.y,
              point.z
            ].join(",")
          );
        });
      });
    });
  }
  return rows.join("\n");
}

export async function buildColabZipBlob(clips: UploadedClip[]): Promise<Blob> {
  const files: Record<string, Uint8Array> = {};
  const used = new Set<string>();
  for (const clip of readyClips(clips)) {
    const record = buildClipRecord(clip);
    const path = uniquePath(used, `${clip.label}/${record.clip}.json`);
    files[path] = strToU8(JSON.stringify(record));
  }
  files["qc_report.csv"] = strToU8(buildQcReportCsv(clips));
  const zipped = await zipAsync(files);
  return new Blob([zipped as BlobPart], { type: "application/zip" });
}

async function renderOverlayWebm(
  file: File,
  landmarker: HandLandmarker,
  clock: MonotonicClock
): Promise<Blob> {
  const vision = await loadVision();
  const connections = vision.HandLandmarker.HAND_CONNECTIONS as HandConnection[];
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = url;

  try {
    await waitForVideoEvent(video, "loadedmetadata", 15000);
    const width = video.videoWidth || 640;
    const height = video.videoHeight || 480;

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not create an overlay canvas.");
    const drawingUtils: DrawingUtils = new vision.DrawingUtils(context);

    const stream = canvas.captureStream(OVERLAY_FPS);
    const mimeType = getBestSupportedMimeType();
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    const stopped = new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
    });

    recorder.start();
    await new Promise<void>((resolve) => {
      let raf = 0;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        window.cancelAnimationFrame(raf);
        window.clearTimeout(safety);
        resolve();
      };
      const safety = window.setTimeout(finish, 180000);
      const step = () => {
        if (video.ended || video.paused) {
          finish();
          return;
        }
        drawVideoFrame(context, video, width, height, false);
        clock.value += Math.max(1, Math.round(1000 / OVERLAY_FPS));
        const result = landmarker.detectForVideo(video, clock.value);
        drawHandLandmarks(drawingUtils, result.landmarks ?? [], connections, width);
        raf = window.requestAnimationFrame(step);
      };
      video.onended = finish;
      video.play().then(() => {
        raf = window.requestAnimationFrame(step);
      }).catch(finish);
    });

    recorder.stop();
    await stopped;
    return new Blob(chunks, { type: mimeType || "video/webm" });
  } finally {
    video.pause();
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  }
}

export async function buildOverlayZipBlob(
  clips: UploadedClip[],
  landmarker: HandLandmarker,
  clock: MonotonicClock,
  onProgress?: (progress: number) => void
): Promise<Blob> {
  const files: Record<string, Uint8Array> = {};
  const used = new Set<string>();
  const targets = readyClips(clips);
  let done = 0;
  for (const clip of targets) {
    const webm = await renderOverlayWebm(clip.file, landmarker, clock);
    const path = uniquePath(used, `${clip.label}/${clipNameFromFilename(clip.fileName)}_overlay.webm`);
    files[path] = new Uint8Array(await webm.arrayBuffer());
    done += 1;
    onProgress?.(done / targets.length);
  }
  // webm is already compressed; store without extra deflate.
  const zipped = await new Promise<Uint8Array>((resolve, reject) => {
    zip(files, { level: 0 }, (error, data) => (error ? reject(error) : resolve(data)));
  });
  return new Blob([zipped as BlobPart], { type: "application/zip" });
}

export async function downloadColabZip(clips: UploadedClip[]): Promise<void> {
  const blob = await buildColabZipBlob(clips);
  downloadBlob(blob, "makalearn_landmarks.zip");
}

export function downloadTable3Csv(clips: UploadedClip[]): void {
  const blob = new Blob([buildTable3Csv(clips)], { type: "text/csv" });
  downloadBlob(blob, "hand_landmark_dataset.csv");
}

export async function downloadOverlayZip(
  clips: UploadedClip[],
  landmarker: HandLandmarker,
  clock: MonotonicClock,
  onProgress?: (progress: number) => void
): Promise<void> {
  const blob = await buildOverlayZipBlob(clips, landmarker, clock, onProgress);
  downloadBlob(blob, "overlay_videos.zip");
}
