import type { HandLandmarker, NormalizedLandmark } from "@mediapipe/tasks-vision";
import type { HandLandmarkPoint } from "./types";

// The recorder and the batch extractor share one model file and one WASM runtime so
// landmarks stay consistent between live capture and offline extraction.
export const trackerModelPath = "/models/hand_landmarker.task";
export const wasmPath = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm";

// The live recorder runs at 0.5 (matches the MakaLearn prototype). The batch extractor runs
// at 0.6 for stricter, cleaner landmark detections — note this is above the Colab notebook's
// 0.3, so coverage/detection-rate numbers will read lower here than in the notebook.
export const LIVE_CONFIDENCE = 0.5;
export const BATCH_CONFIDENCE = 0.6;

let visionModulePromise: Promise<typeof import("@mediapipe/tasks-vision")> | null = null;

export function loadVision() {
  if (!visionModulePromise) {
    visionModulePromise = import("@mediapipe/tasks-vision");
  }
  return visionModulePromise;
}

// Round landmark coordinates to 5 decimals (matches the recorder and the Colab notebook).
export function toSerializableHand(hand: NormalizedLandmark[]): HandLandmarkPoint[] {
  return hand.map((point) => ({
    x: Number(point.x.toFixed(5)),
    y: Number(point.y.toFixed(5)),
    z: Number(point.z.toFixed(5))
  }));
}

export async function createHandLandmarker(options?: {
  confidence?: number;
  numHands?: number;
}): Promise<HandLandmarker> {
  const confidence = options?.confidence ?? LIVE_CONFIDENCE;
  const vision = await loadVision();
  const fileset = await vision.FilesetResolver.forVisionTasks(wasmPath);
  return vision.HandLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: trackerModelPath },
    runningMode: "VIDEO",
    numHands: options?.numHands ?? 2,
    minHandDetectionConfidence: confidence,
    minHandPresenceConfidence: confidence,
    minTrackingConfidence: confidence
  });
}
