import { useEffect, useMemo, useRef, useState } from "react";
import type { DrawingUtils, HandLandmarker, NormalizedLandmark } from "@mediapipe/tasks-vision";
import {
  Camera,
  CircleStop,
  Download,
  FileJson,
  Hand,
  Mic,
  MicOff,
  Play,
  RefreshCw,
  Save,
  ShieldCheck,
  Sparkles,
  Video
} from "lucide-react";
import { createFileBaseName, createRecordingId, downloadBlob, downloadMetadata } from "./file-utils";
import { gestureLabels } from "./labels";
import { getBestSupportedMimeType, getCameraStream, isSecureCameraContext } from "./media";
import { createHandLandmarker, loadVision, toSerializableHand } from "./landmarker";
import { drawHandLandmarks, drawVideoFrame, roundRect, type HandConnection } from "./draw";
import { BatchPanel } from "./batch/BatchPanel";
import type {
  CameraView,
  CompletedRecording,
  HandFrameSample,
  RecorderForm,
  RecordingMetadata,
  RecordingStatus
} from "./types";

type Toast = { tone: "good" | "warn" | "info"; message: string };

const initialForm: RecorderForm = {
  label: "eat",
  participantId: "P01",
  takeNumber: "1",
  cameraView: "front",
  customCameraView: "",
  notes: "",
  includeAudio: false,
  mirrorPreview: true,
  autoDownloadAfterStop: true
};

const cameraViews: Array<{ value: CameraView; label: string }> = [
  { value: "front", label: "Front" },
  { value: "left-side", label: "Left side" },
  { value: "right-side", label: "Right side" },
  { value: "close-up", label: "Close-up" },
  { value: "custom", label: "Custom" }
];

export function App() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const handLandmarkerRef = useRef<HandLandmarker | null>(null);
  const drawingUtilsRef = useRef<DrawingUtils | null>(null);
  const handConnectionsRef = useRef<HandConnection[]>([]);
  const animationFrameRef = useRef<number | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const frameSamplesRef = useRef<HandFrameSample[]>([]);
  const recordingStartedAtRef = useRef<Date | null>(null);
  const recordingMimeTypeRef = useRef("video/webm");
  const formRef = useRef(initialForm);
  const showLandmarksRef = useRef(true);
  const recordingUrlsRef = useRef<string[]>([]);
  const [form, setForm] = useState<RecorderForm>(initialForm);
  const [status, setStatus] = useState<RecordingStatus>("idle");
  const [trackerStatus, setTrackerStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [handCount, setHandCount] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [recordings, setRecordings] = useState<CompletedRecording[]>([]);
  const [toast, setToast] = useState<Toast | null>(null);
  const [showLandmarks, setShowLandmarks] = useState(true);
  const [cameraSize, setCameraSize] = useState({ width: 1280, height: 720 });

  const canUseCamera = isSecureCameraContext();
  // Allow re-recording after a take: once a clip is saved the status is "recorded" but the
  // camera and tracking loop are still live, so the button must stay enabled.
  const canRecord =
    (status === "camera-ready" || status === "recorded") &&
    Boolean(form.label.trim()) &&
    Boolean(form.participantId.trim());
  const latestRecording = recordings[0];
  const recordingStateLabel = useMemo(() => {
    if (status === "recording") return "Recording";
    if (status === "recorded") return "Saved in this session";
    if (status === "camera-ready") return "Camera ready";
    if (status === "error") return "Needs attention";
    return "Camera off";
  }, [status]);

  function stopRecordingTracks() {
    if (animationFrameRef.current !== null) {
      window.cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }

    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;

    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.srcObject = null;
    }
  }

  useEffect(() => {
    formRef.current = form;
  }, [form]);

  useEffect(() => {
    const recordingUrls = recordingUrlsRef.current;
    return () => {
      stopRecordingTracks();
      handLandmarkerRef.current?.close();
      recordingUrls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, []);

  useEffect(() => {
    showLandmarksRef.current = showLandmarks;
  }, [showLandmarks]);

  useEffect(() => {
    if (status !== "recording") return;
    const timer = window.setInterval(() => {
      const startedAt = recordingStartedAtRef.current;
      if (startedAt) setElapsedMs(Date.now() - startedAt.getTime());
    }, 250);
    return () => window.clearInterval(timer);
  }, [status]);

  async function prepareHandTracker() {
    if (handLandmarkerRef.current && drawingUtilsRef.current) return handLandmarkerRef.current;

    setTrackerStatus("loading");
    const vision = await loadVision();
    const handLandmarker = await createHandLandmarker();

    const canvasContext = canvasRef.current?.getContext("2d");
    if (!canvasContext) throw new Error("The recording canvas is unavailable.");

    handLandmarkerRef.current = handLandmarker;
    drawingUtilsRef.current = new vision.DrawingUtils(canvasContext);
    handConnectionsRef.current = vision.HandLandmarker.HAND_CONNECTIONS;
    setTrackerStatus("ready");
    return handLandmarker;
  }

  async function startCamera() {
    if (!canUseCamera) {
      setStatus("error");
      showToast("warn", "Open this page through HTTPS or localhost to allow camera access.");
      return;
    }

    try {
      stopRecordingTracks();
      setStatus("idle");
      setElapsedMs(0);

      const stream = await getCameraStream(form.includeAudio);
      streamRef.current = stream;

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }

      await prepareHandTracker();
      setStatus("camera-ready");
      showToast("good", "Camera is ready. Landmarks will be saved in the video preview.");
      runFrameLoop();
    } catch (error) {
      console.error(error);
      setTrackerStatus("error");
      setStatus("error");
      showToast("warn", "Camera could not start. Check browser permission and try again.");
    }
  }

  function runFrameLoop() {
    if (animationFrameRef.current !== null) window.cancelAnimationFrame(animationFrameRef.current);

    const draw = () => {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      const context = canvas?.getContext("2d");
      const handLandmarker = handLandmarkerRef.current;
      const drawingUtils = drawingUtilsRef.current;

      if (video && canvas && context && handLandmarker && drawingUtils && video.readyState >= 2) {
        const width = video.videoWidth || 1280;
        const height = video.videoHeight || 720;
        if (canvas.width !== width || canvas.height !== height) {
          canvas.width = width;
          canvas.height = height;
          setCameraSize({ width, height });
        }

        context.clearRect(0, 0, width, height);
        drawVideoFrame(context, video, width, height, formRef.current.mirrorPreview);

        const result = handLandmarker.detectForVideo(video, performance.now());
        const landmarks = formRef.current.mirrorPreview ? mirrorHands(result.landmarks) : result.landmarks;

        if (showLandmarksRef.current) {
          drawHandLandmarks(drawingUtils, landmarks, handConnectionsRef.current, width);
        }

        drawRecordingOverlay(context, width, height, result.landmarks.length);
        setHandCount(result.landmarks.length);

        if (mediaRecorderRef.current?.state === "recording") {
          frameSamplesRef.current.push({
            timestampMs: Date.now() - (recordingStartedAtRef.current?.getTime() ?? Date.now()),
            handCount: result.landmarks.length,
            hands: result.landmarks.map(toSerializableHand)
          });
        }
      }

      animationFrameRef.current = window.requestAnimationFrame(draw);
    };

    draw();
  }

  function startRecording() {
    const canvas = canvasRef.current;
    const cameraStream = streamRef.current;
    if (!canvas || !cameraStream || !canRecord) {
      showToast("warn", "Add a label and participant ID before recording.");
      return;
    }

    const canvasStream = canvas.captureStream(30);
    const outputStream = new MediaStream(canvasStream.getVideoTracks());
    if (form.includeAudio) {
      cameraStream.getAudioTracks().forEach((track) => outputStream.addTrack(track));
    }

    const mimeType = getBestSupportedMimeType();
    const mediaRecorder = new MediaRecorder(outputStream, mimeType ? { mimeType } : undefined);
    recordedChunksRef.current = [];
    frameSamplesRef.current = [];
    recordingStartedAtRef.current = new Date();
    recordingMimeTypeRef.current = mimeType || "video/webm";

    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) recordedChunksRef.current.push(event.data);
    };

    mediaRecorder.onstop = finishRecording;
    mediaRecorder.onerror = () => {
      setStatus("error");
      showToast("warn", "The recording stopped unexpectedly.");
    };

    mediaRecorderRef.current = mediaRecorder;
    mediaRecorder.start(1000);
    setElapsedMs(0);
    setStatus("recording");
    showToast("info", "Recording started.");
  }

  function stopRecording() {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state !== "recording") return;
    recorder.stop();
  }

  function finishRecording() {
    const startedAt = recordingStartedAtRef.current ?? new Date();
    const endedAt = new Date();
    const currentForm = formRef.current;
    const cameraView = currentForm.cameraView === "custom" ? currentForm.customCameraView : currentForm.cameraView;
    const recordingId = createRecordingId();
    const durationMs = endedAt.getTime() - startedAt.getTime();
    const videoBlob = new Blob(recordedChunksRef.current, { type: recordingMimeTypeRef.current });
    const fileBaseName = createFileBaseName({
      label: currentForm.label,
      participantId: currentForm.participantId,
      takeNumber: currentForm.takeNumber,
      cameraView,
      createdAt: startedAt
    });

    const metadata: RecordingMetadata = {
      recordingId,
      label: currentForm.label,
      participantId: currentForm.participantId,
      takeNumber: currentForm.takeNumber,
      cameraView,
      notes: currentForm.notes,
      includeAudio: currentForm.includeAudio,
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      durationMs,
      video: {
        width: cameraSize.width,
        height: cameraSize.height,
        frameRate: 30,
        mimeType: recordingMimeTypeRef.current,
        mirrored: currentForm.mirrorPreview
      },
      detection: {
        model: "MediaPipe hand_landmarker.task",
        detectedFrameCount: frameSamplesRef.current.filter((frame) => frame.handCount > 0).length,
        maxHands: 2,
        frameSamples: frameSamplesRef.current
      }
    };

    const videoUrl = URL.createObjectURL(videoBlob);
    recordingUrlsRef.current.push(videoUrl);

    const completed: CompletedRecording = {
      id: recordingId,
      fileBaseName,
      videoBlob,
      metadata,
      videoUrl,
      createdAt: endedAt.toISOString()
    };

    setRecordings((current) => [completed, ...current]);
    setStatus("recorded");
    setElapsedMs(durationMs);
    mediaRecorderRef.current = null;
    showToast("good", "Recording finished. Save the video and metadata before closing this page.");

    if (currentForm.autoDownloadAfterStop) {
      window.setTimeout(() => {
        downloadBlob(videoBlob, `${fileBaseName}.webm`);
        downloadMetadata(metadata, fileBaseName);
      }, 300);
    }
  }

  function stopCamera() {
    if (mediaRecorderRef.current?.state === "recording") mediaRecorderRef.current.stop();
    stopRecordingTracks();
    setStatus("idle");
    setHandCount(0);
    setElapsedMs(0);
    drawIdleCanvas();
  }

  function drawIdleCanvas() {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
  }

  function updateForm<Key extends keyof RecorderForm>(key: Key, value: RecorderForm[Key]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function saveLatestVideo() {
    if (!latestRecording) return;
    downloadBlob(latestRecording.videoBlob, `${latestRecording.fileBaseName}.webm`);
  }

  function saveLatestMetadata() {
    if (!latestRecording) return;
    downloadMetadata(latestRecording.metadata, latestRecording.fileBaseName);
  }

  function saveBoth(recording: CompletedRecording) {
    downloadBlob(recording.videoBlob, `${recording.fileBaseName}.webm`);
    window.setTimeout(() => downloadMetadata(recording.metadata, recording.fileBaseName), 250);
  }

  function showToast(tone: Toast["tone"], message: string) {
    setToast({ tone, message });
    window.setTimeout(() => setToast(null), 4200);
  }

  return (
    <main className="app-shell">
      <section className="hero-panel">
        <div>
          <p className="eyebrow">Dataset capture station</p>
          <h1>Record clean gesture clips with landmarks already on the video.</h1>
          <p className="hero-copy">
            Set the label, start the camera, record a take, then save the marked video and metadata
            before moving to the next clip.
          </p>
        </div>
        <div className="status-tile">
          <span className={`pulse-dot ${status === "recording" ? "is-recording" : ""}`} />
          <div>
            <strong>{recordingStateLabel}</strong>
            <span>{formatTime(elapsedMs)} · {handCount} hand{handCount === 1 ? "" : "s"} visible</span>
          </div>
        </div>
      </section>

      <section className="recorder-grid">
        <div className="camera-stage">
          <div className="stage-toolbar">
            <div>
              <p className="stage-label">Live capture</p>
              <strong>{trackerStatus === "loading" ? "Preparing hand tracker" : "Camera preview"}</strong>
            </div>
            <div className="toolbar-actions">
              <button
                className={`icon-toggle ${showLandmarks ? "active" : ""}`}
                type="button"
                onClick={() => setShowLandmarks((current) => !current)}
                title="Toggle landmarks"
              >
                <Hand size={18} />
              </button>
              <button
                className={`icon-toggle ${form.includeAudio ? "active" : ""}`}
                type="button"
                onClick={() => updateForm("includeAudio", !form.includeAudio)}
                title="Toggle microphone before starting camera"
                disabled={status === "recording"}
              >
                {form.includeAudio ? <Mic size={18} /> : <MicOff size={18} />}
              </button>
            </div>
          </div>

          <div className="canvas-wrap">
            <video ref={videoRef} playsInline muted className="source-video" />
            <canvas ref={canvasRef} width="1280" height="720" aria-label="Camera preview with hand landmarks" />
            {status === "idle" || status === "error" ? (
              <div className="camera-empty">
                <Camera size={36} />
                <strong>{canUseCamera ? "Start the camera when the take is ready." : "HTTPS is required for phone camera access."}</strong>
                <span>{canUseCamera ? "The saved video will match this preview." : "Use localhost on laptop or a temporary HTTPS tunnel on Android."}</span>
              </div>
            ) : null}
          </div>

          <div className="control-strip">
            <button className="button secondary" type="button" onClick={startCamera} disabled={status === "recording"}>
              <Camera size={18} />
              {status === "camera-ready" || status === "recorded" ? "Restart camera" : "Start camera"}
            </button>
            {status === "recording" ? (
              <button className="button danger" type="button" onClick={stopRecording}>
                <CircleStop size={18} />
                End recording
              </button>
            ) : (
              <button className="button primary" type="button" onClick={startRecording} disabled={!canRecord}>
                <Play size={18} />
                Start recording
              </button>
            )}
            <button className="button ghost" type="button" onClick={stopCamera}>
              <RefreshCw size={18} />
              Stop camera
            </button>
          </div>
        </div>

        <aside className="setup-panel">
          <div className="panel-heading">
            <p className="eyebrow">Take setup</p>
            <h2>Clip details</h2>
          </div>

          <label className="field">
            <span>Gesture label</span>
            <input
              list="gesture-labels"
              value={form.label}
              onChange={(event) => updateForm("label", event.target.value)}
              placeholder="Example: Hello"
            />
            <datalist id="gesture-labels">
              {gestureLabels.map((label) => (
                <option key={label} value={label} />
              ))}
            </datalist>
          </label>

          <div className="field-pair">
            <label className="field">
              <span>Participant ID</span>
              <input value={form.participantId} onChange={(event) => updateForm("participantId", event.target.value)} />
            </label>
            <label className="field">
              <span>Take</span>
              <input
                inputMode="numeric"
                value={form.takeNumber}
                onChange={(event) => updateForm("takeNumber", event.target.value)}
              />
            </label>
          </div>

          <label className="field">
            <span>Camera view</span>
            <select value={form.cameraView} onChange={(event) => updateForm("cameraView", event.target.value as CameraView)}>
              {cameraViews.map((view) => (
                <option key={view.value} value={view.value}>
                  {view.label}
                </option>
              ))}
            </select>
          </label>

          {form.cameraView === "custom" ? (
            <label className="field">
              <span>Custom view name</span>
              <input
                value={form.customCameraView}
                onChange={(event) => updateForm("customCameraView", event.target.value)}
                placeholder="Example: desk tripod"
              />
            </label>
          ) : null}

          <label className="field">
            <span>Notes</span>
            <textarea
              value={form.notes}
              onChange={(event) => updateForm("notes", event.target.value)}
              placeholder="Lighting, distance, signer notes, or retake reason"
            />
          </label>

          <div className="switch-list">
            <label className="switch-row">
              <input
                type="checkbox"
                checked={form.mirrorPreview}
                onChange={(event) => updateForm("mirrorPreview", event.target.checked)}
              />
              <span>
                <strong>Mirror front camera</strong>
                <small>Usually easier for phone recording.</small>
              </span>
            </label>
            <label className="switch-row">
              <input
                type="checkbox"
                checked={form.autoDownloadAfterStop}
                onChange={(event) => updateForm("autoDownloadAfterStop", event.target.checked)}
              />
              <span>
                <strong>Download after ending</strong>
                <small>The browser may still ask for confirmation.</small>
              </span>
            </label>
          </div>

          <div className="save-box">
            <div>
              <Save size={20} />
              <strong>Latest recording</strong>
              <span>{latestRecording ? latestRecording.fileBaseName : "No saved take yet"}</span>
            </div>
            <div className="save-actions">
              <button className="button secondary" type="button" onClick={saveLatestVideo} disabled={!latestRecording}>
                <Download size={17} />
                Video
              </button>
              <button className="button secondary" type="button" onClick={saveLatestMetadata} disabled={!latestRecording}>
                <FileJson size={17} />
                JSON
              </button>
            </div>
          </div>
        </aside>
      </section>

      <section className="session-panel">
        <div className="panel-heading">
          <p className="eyebrow">This browser session</p>
          <h2>Recorded takes</h2>
        </div>

        {recordings.length ? (
          <div className="recording-list">
            {recordings.map((recording) => (
              <article className="recording-card" key={recording.id}>
                <video src={recording.videoUrl} controls playsInline />
                <div>
                  <strong>{recording.metadata.label}</strong>
                  <span>
                    {recording.metadata.participantId} · take {recording.metadata.takeNumber} · {formatTime(recording.metadata.durationMs)}
                  </span>
                  <button className="button compact" type="button" onClick={() => saveBoth(recording)}>
                    <Download size={16} />
                    Save both files
                  </button>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="empty-session">
            <Video size={28} />
            <strong>No recordings yet</strong>
            <span>Finished takes will stay here until you close or refresh the page.</span>
          </div>
        )}
      </section>

      <BatchPanel onNotify={showToast} />

      <section className="phone-note">
        <ShieldCheck size={22} />
        <div>
          <strong>Android testing over HTTPS</strong>
          <span>
            Run the app on a laptop, open a temporary HTTPS tunnel, then use that link in Android Chrome.
            Downloads save to the phone after the recorder creates the files.
          </span>
        </div>
      </section>

      {toast ? (
        <div className={`toast ${toast.tone}`}>
          <Sparkles size={18} />
          {toast.message}
        </div>
      ) : null}
    </main>
  );
}

function drawRecordingOverlay(context: CanvasRenderingContext2D, width: number, height: number, handCount: number) {
  context.save();
  context.fillStyle = "rgba(8, 31, 45, 0.58)";
  context.strokeStyle = "rgba(255, 255, 255, 0.32)";
  context.lineWidth = 2;
  roundRect(context, 18, 18, Math.min(230, width - 36), 46, 16);
  context.fill();
  context.stroke();
  context.fillStyle = "#ffffff";
  context.font = `${Math.max(16, width * 0.018)}px Inter, system-ui, sans-serif`;
  context.fillText(`${handCount} hand${handCount === 1 ? "" : "s"} visible`, 38, 49);
  context.restore();
}

function mirrorHands(hands: NormalizedLandmark[][]) {
  return hands.map((hand) =>
    hand.map((point) => ({
      ...point,
      x: 1 - point.x
    }))
  );
}

function formatTime(milliseconds: number) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, "0");
  const seconds = (totalSeconds % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}
