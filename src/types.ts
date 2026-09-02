export type RecordingStatus = "idle" | "camera-ready" | "recording" | "recorded" | "error";

export type CameraView = "front" | "left-side" | "right-side" | "close-up" | "custom";

export type HandLandmarkPoint = {
  x: number;
  y: number;
  z: number;
};

export type HandFrameSample = {
  timestampMs: number;
  handCount: number;
  hands: HandLandmarkPoint[][];
};

export type RecorderForm = {
  label: string;
  participantId: string;
  takeNumber: string;
  cameraView: CameraView;
  customCameraView: string;
  notes: string;
  includeAudio: boolean;
  mirrorPreview: boolean;
  autoDownloadAfterStop: boolean;
};

export type RecordingMetadata = {
  recordingId: string;
  label: string;
  participantId: string;
  takeNumber: string;
  cameraView: string;
  notes: string;
  includeAudio: boolean;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  video: {
    width: number;
    height: number;
    frameRate: number;
    mimeType: string;
    mirrored: boolean;
  };
  detection: {
    model: string;
    detectedFrameCount: number;
    maxHands: number;
    frameSamples: HandFrameSample[];
  };
};

export type CompletedRecording = {
  id: string;
  fileBaseName: string;
  videoBlob: Blob;
  metadata: RecordingMetadata;
  videoUrl: string;
  createdAt: string;
};

// ---------------------------------------------------------------------------
// Batch video landmark extraction
// ---------------------------------------------------------------------------

export type HandTypeLabel = "Left" | "Right" | "Unknown";

// One extracted frame. `hands` keeps MediaPipe's order; `handedness` is the parallel
// Left/Right label per hand. This is a superset of the Colab notebook's per-frame shape
// (timestampMs, handCount, hands) so exported JSON stays drop-in compatible.
export type BatchFrameSample = {
  timestampMs: number;
  handCount: number;
  hands: HandLandmarkPoint[][];
  handedness: HandTypeLabel[];
};

export type ClipExtraction = {
  fps: number;
  width: number;
  height: number;
  frames: BatchFrameSample[];
};

// "auto" treats any detected hand as a hit; 1 or 2 requires that many hands per frame.
export type ExpectedHands = "auto" | 1 | 2;

export type Table4Verdict = "accept" | "accept-if-complete" | "review" | "re-record";
export type NotebookStatus = "pass" | "warn" | "fail";

export type ClipQc = {
  frameCount: number;
  anyHandFrameCount: number; // frames with >= 1 hand (the notebook's "detected")
  requiredHandFrameCount: number; // frames meeting expectedHands
  coverage: number; // anyHandFrameCount / frameCount, 0..1 (notebook coverage)
  detectionRate: number; // requiredHandFrameCount / frameCount, 0..1 (manuscript Eq. 2)
  maxHandsSeen: number;
  durationSec: number;
  table4: Table4Verdict;
  notebookStatus: NotebookStatus;
  notebookReason: string;
  flags: string[];
};

export type ClipStatus = "queued" | "processing" | "done" | "error";

export type UploadedClip = {
  id: string;
  file: File;
  fileName: string;
  label: string;
  expectedHands: ExpectedHands;
  status: ClipStatus;
  progress: number; // 0..1 during extraction
  error?: string;
  extraction?: ClipExtraction;
  qc?: ClipQc;
};

// The exact per-clip record shape written by the Colab notebook (makalearn_landmark_extraction).
// `handedness` is an extra field the notebook ignores.
export type NotebookClipRecord = {
  label: string;
  clip: string;
  source: string;
  fps: number;
  frameCount: number;
  detectedFrameCount: number;
  coverage: number;
  status: NotebookStatus;
  model: string;
  maxHands: number;
  frameSamples: BatchFrameSample[];
};
