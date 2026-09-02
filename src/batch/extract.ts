import type { HandLandmarker } from "@mediapipe/tasks-vision";
import { toSerializableHand } from "../landmarker";
import type { BatchFrameSample, ClipExtraction, HandTypeLabel } from "../types";

// We sample every clip at a fixed cadence. The Colab notebook uses each video's true fps,
// but the training tensor only consumes frameSamples/handCount, so a fixed 30 fps sampling
// keeps coverage a consistent ratio and stays drop-in compatible.
const SAMPLE_FPS = 30;

// MediaPipe VIDEO mode rejects non-increasing timestamps for the life of one landmarker.
// Since we reuse a single landmarker across the whole batch, the caller passes one shared
// clock whose value only ever goes up.
export type MonotonicClock = { value: number };

export function createClock(): MonotonicClock {
  return { value: 0 };
}

export function clipNameFromFilename(fileName: string): string {
  return fileName.replace(/\.[^./\\]+$/, "");
}

// Filename prefix = label: leading letters before any separator/digit, lowercased.
// "eat_001.mov" -> "eat", "help-2.mp4" -> "help", "yes3.webm" -> "yes".
export function parseLabelFromFilename(fileName: string): string {
  const base = clipNameFromFilename(fileName);
  const match = base.match(/^[A-Za-z]+/);
  return (match ? match[0] : base).toLowerCase();
}

export function waitForVideoEvent(
  target: HTMLVideoElement,
  event: string,
  timeoutMs: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      target.removeEventListener(event, onEvent);
      target.removeEventListener("error", onError);
      window.clearTimeout(timer);
    };
    const onEvent = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("The video could not be decoded."));
    };
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for "${event}".`));
    }, timeoutMs);
    target.addEventListener(event, onEvent, { once: true });
    target.addEventListener("error", onError, { once: true });
  });
}

// Some containers (notably webm from MediaRecorder) report duration = Infinity until seeked.
async function resolveDuration(video: HTMLVideoElement): Promise<number> {
  if (Number.isFinite(video.duration) && video.duration > 0) return video.duration;
  video.currentTime = 1e101;
  await waitForVideoEvent(video, "seeked", 8000).catch(() => undefined);
  if (Number.isFinite(video.duration) && video.duration > 0) {
    const duration = video.duration;
    video.currentTime = 0;
    await waitForVideoEvent(video, "seeked", 8000).catch(() => undefined);
    return duration;
  }
  return 0;
}

async function seekTo(video: HTMLVideoElement, time: number): Promise<void> {
  if (Math.abs(video.currentTime - time) < 1e-4) return;
  video.currentTime = time;
  await waitForVideoEvent(video, "seeked", 8000);
}

function detectFrame(
  video: HTMLVideoElement,
  landmarker: HandLandmarker,
  clock: MonotonicClock,
  timestampMs: number
): BatchFrameSample {
  clock.value += Math.max(1, Math.round(1000 / SAMPLE_FPS));
  const result = landmarker.detectForVideo(video, clock.value);
  const hands = result.landmarks ?? [];
  const handedness: HandTypeLabel[] = (result.handednesses ?? []).map(
    (categories) => (categories[0]?.categoryName as HandTypeLabel) ?? "Unknown"
  );
  return {
    timestampMs,
    handCount: hands.length,
    hands: hands.map(toSerializableHand),
    handedness
  };
}

// Preferred path: the video reports a real duration and is seekable, so we step through it
// frame-by-frame (like the notebook's OpenCV loop). Deterministic and fast, works while hidden.
async function extractBySeeking(
  video: HTMLVideoElement,
  landmarker: HandLandmarker,
  clock: MonotonicClock,
  duration: number,
  onProgress?: (progress: number) => void
): Promise<BatchFrameSample[]> {
  const frames: BatchFrameSample[] = [];
  const frameCount = Math.max(1, Math.round(duration * SAMPLE_FPS));
  for (let i = 0; i < frameCount; i += 1) {
    const targetTime = Math.min(duration - 1e-3, i / SAMPLE_FPS);
    await seekTo(video, targetTime);
    frames.push(detectFrame(video, landmarker, clock, Math.round((i / SAMPLE_FPS) * 1000)));
    if (onProgress && (i % 3 === 0 || i === frameCount - 1)) onProgress((i + 1) / frameCount);
  }
  return frames;
}

// Fallback: some containers (notably webm from MediaRecorder — including this app's own
// recordings) report no duration and are not seekable. Play the clip once and sample each
// presented frame via requestVideoFrameCallback (rAF if unavailable).
async function extractByPlayback(
  video: HTMLVideoElement,
  landmarker: HandLandmarker,
  clock: MonotonicClock,
  onProgress?: (progress: number) => void
): Promise<BatchFrameSample[]> {
  const frames: BatchFrameSample[] = [];
  const rvfc = (
    video as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: (now: number, meta: { mediaTime: number }) => void) => number;
    }
  ).requestVideoFrameCallback?.bind(video);
  const knownDuration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;

  try {
    video.currentTime = 0;
  } catch {
    // ignore — not seekable
  }
  await video.play().catch(() => undefined);

  await new Promise<void>((resolve) => {
    let stopped = false;
    let stall = 0;
    const finish = () => {
      if (stopped) return;
      stopped = true;
      window.clearTimeout(safety);
      window.clearTimeout(stall);
      resolve();
    };
    // Overall cap for a long clip, plus a stall watchdog: if playback never starts (an
    // unplayable/degenerate file) or stops advancing, bail instead of waiting the full cap.
    const safety = window.setTimeout(finish, 180000);
    const armStall = (ms: number) => {
      window.clearTimeout(stall);
      stall = window.setTimeout(finish, ms);
    };
    armStall(6000);

    const record = (mediaTime: number) => {
      frames.push(detectFrame(video, landmarker, clock, Math.round(mediaTime * 1000)));
      if (onProgress && knownDuration) onProgress(Math.min(1, mediaTime / knownDuration));
      armStall(4000);
    };

    video.addEventListener("ended", finish, { once: true });

    if (rvfc) {
      const onFrame = (_now: number, meta: { mediaTime: number }) => {
        if (stopped) return;
        record(typeof meta?.mediaTime === "number" ? meta.mediaTime : video.currentTime);
        if (video.ended) {
          finish();
          return;
        }
        rvfc(onFrame);
      };
      rvfc(onFrame);
    } else {
      const step = () => {
        if (stopped) return;
        record(video.currentTime);
        if (video.ended || video.paused) {
          finish();
          return;
        }
        window.requestAnimationFrame(step);
      };
      window.requestAnimationFrame(step);
    }
  });

  video.pause();
  return frames;
}

export async function extractClip(
  file: File,
  landmarker: HandLandmarker,
  clock: MonotonicClock,
  onProgress?: (progress: number) => void
): Promise<ClipExtraction> {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.crossOrigin = "anonymous";
  video.src = url;

  try {
    await waitForVideoEvent(video, "loadedmetadata", 15000);
    const width = video.videoWidth || 640;
    const height = video.videoHeight || 480;
    const duration = await resolveDuration(video);
    const seekable = video.seekable.length > 0 && video.seekable.end(0) > 0;

    const frames =
      duration && seekable
        ? await extractBySeeking(video, landmarker, clock, duration, onProgress)
        : await extractByPlayback(video, landmarker, clock, onProgress);

    return { fps: SAMPLE_FPS, width, height, frames };
  } finally {
    video.pause();
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  }
}
