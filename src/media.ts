export function getBestSupportedMimeType() {
  const candidates = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm"
  ];

  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) ?? "";
}

export async function getCameraStream(includeAudio: boolean) {
  return navigator.mediaDevices.getUserMedia({
    audio: includeAudio
      ? {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      : false,
    video: {
      facingMode: "user",
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30, max: 30 }
    }
  });
}

export function isSecureCameraContext() {
  return window.isSecureContext && Boolean(navigator.mediaDevices?.getUserMedia);
}

