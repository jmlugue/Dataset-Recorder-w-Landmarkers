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
