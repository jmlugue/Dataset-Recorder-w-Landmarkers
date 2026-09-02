import { useEffect, useRef, useState } from "react";
import type { HandLandmarker } from "@mediapipe/tasks-vision";
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  FileJson,
  FilePlus,
  FileVideo,
  Film,
  FolderPlus,
  RefreshCw,
  Sheet,
  Trash2,
  Wand2,
  XCircle
} from "lucide-react";
import { BATCH_CONFIDENCE, createHandLandmarker } from "../landmarker";
import { createRecordingId } from "../file-utils";
import type { ExpectedHands, UploadedClip } from "../types";
import { createClock, extractClip, parseLabelFromFilename, type MonotonicClock } from "./extract";
import { computeQc, isModelReady, table4Label } from "./qc";
import { downloadColabZip, downloadOverlayZip, downloadTable3Csv } from "./export";

type Notify = (tone: "good" | "warn" | "info", message: string) => void;

const VIDEO_EXTENSIONS = [".mp4", ".mov", ".webm", ".avi", ".m4v", ".mkv", ".ogv"];

function isVideoFile(file: File): boolean {
  if (file.type.startsWith("video/")) return true;
  const lower = file.name.toLowerCase();
  return VIDEO_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function toExpectedHands(value: string): ExpectedHands {
  if (value === "1") return 1;
  if (value === "2") return 2;
  return "auto";
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function BatchPanel({ onNotify }: { onNotify?: Notify }) {
  const [clips, setClips] = useState<UploadedClip[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [exporting, setExporting] = useState<null | "colab" | "csv" | "overlay">(null);
  const [exportProgress, setExportProgress] = useState(0);

  const landmarkerRef = useRef<HandLandmarker | null>(null);
  const clockRef = useRef<MonotonicClock>(createClock());
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    // Native folder picking needs the non-standard webkitdirectory attribute.
    folderInputRef.current?.setAttribute("webkitdirectory", "");
    folderInputRef.current?.setAttribute("directory", "");
  }, []);

  useEffect(() => {
    return () => {
      landmarkerRef.current?.close();
      landmarkerRef.current = null;
    };
  }, []);

  const readyClips = clips.filter((clip) => clip.extraction && clip.qc);
  const hasExportable = readyClips.length > 0;
  const busy = isProcessing || exporting !== null;
  const queuedCount = clips.filter((clip) => clip.status === "queued").length;

  const verdictTotals = readyClips.reduce(
    (totals, clip) => {
      if (clip.qc && isModelReady(clip.qc)) totals.ready += 1;
      else totals.notReady += 1;
      return totals;
    },
    { ready: 0, notReady: 0 }
  );

  function updateClip(id: string, patch: Partial<UploadedClip>) {
    setClips((current) => current.map((clip) => (clip.id === id ? { ...clip, ...patch } : clip)));
  }

  function addFiles(fileList: FileList | null) {
    if (!fileList) return;
    const incoming = Array.from(fileList).filter(isVideoFile);
    if (!incoming.length) {
      onNotify?.("warn", "No supported video files were found in that selection.");
      return;
    }
    const newClips: UploadedClip[] = incoming.map((file) => ({
      id: createRecordingId(),
      file,
      fileName: file.name,
      label: parseLabelFromFilename(file.name),
      expectedHands: "auto",
      status: "queued",
      progress: 0
    }));
    setClips((current) => [...current, ...newClips]);
    onNotify?.("info", `Added ${newClips.length} clip${newClips.length === 1 ? "" : "s"}.`);
  }

  async function ensureLandmarker(): Promise<HandLandmarker> {
    if (!landmarkerRef.current) {
      landmarkerRef.current = await createHandLandmarker({ confidence: BATCH_CONFIDENCE });
    }
    return landmarkerRef.current;
  }

  async function processClip(clip: UploadedClip, landmarker: HandLandmarker) {
    updateClip(clip.id, { status: "processing", progress: 0, error: undefined });
    try {
      const extraction = await extractClip(clip.file, landmarker, clockRef.current, (progress) =>
        updateClip(clip.id, { progress })
      );
      const qc = computeQc(extraction, clip.expectedHands);
      updateClip(clip.id, { status: "done", progress: 1, extraction, qc });
    } catch (error) {
      console.error(error);
      updateClip(clip.id, {
        status: "error",
        error: error instanceof Error ? error.message : "Extraction failed."
      });
    }
  }

  async function processQueued() {
    const pending = clips.filter((clip) => clip.status === "queued" || clip.status === "error");
    if (!pending.length) return;
    setIsProcessing(true);
    try {
      const landmarker = await ensureLandmarker();
      for (const clip of pending) {
        await processClip(clip, landmarker);
      }
      onNotify?.("good", "Landmark extraction finished.");
    } catch (error) {
      console.error(error);
      onNotify?.("warn", "The hand tracker could not be loaded.");
    } finally {
      setIsProcessing(false);
    }
  }

  async function reprocessClip(id: string) {
    const clip = clips.find((item) => item.id === id);
    if (!clip || busy) return;
    setIsProcessing(true);
    try {
      const landmarker = await ensureLandmarker();
      await processClip(clip, landmarker);
    } finally {
      setIsProcessing(false);
    }
  }

  function changeExpectedHands(id: string, value: string) {
    const expectedHands = toExpectedHands(value);
    setClips((current) =>
      current.map((clip) => {
        if (clip.id !== id) return clip;
        const qc = clip.extraction ? computeQc(clip.extraction, expectedHands) : clip.qc;
        return { ...clip, expectedHands, qc };
      })
    );
  }

  function removeClip(id: string) {
    setClips((current) => current.filter((clip) => clip.id !== id));
  }

  function clearAll() {
    if (busy) return;
    setClips([]);
  }

  async function runExport(kind: "colab" | "csv" | "overlay") {
    if (!hasExportable || busy) return;
    setExporting(kind);
    setExportProgress(0);
    try {
      if (kind === "colab") {
        await downloadColabZip(clips);
        onNotify?.("good", "Colab-compatible landmark ZIP downloaded.");
      } else if (kind === "csv") {
        downloadTable3Csv(clips);
        onNotify?.("good", "Table 3 CSV downloaded.");
      } else {
        const landmarker = await ensureLandmarker();
        await downloadOverlayZip(clips, landmarker, clockRef.current, setExportProgress);
        onNotify?.("good", "Overlay videos ZIP downloaded.");
      }
    } catch (error) {
      console.error(error);
      onNotify?.("warn", "Export failed. See the console for details.");
    } finally {
      setExporting(null);
      setExportProgress(0);
    }
  }

  return (
    <section className="batch-panel">
      <div className="panel-heading">
        <p className="eyebrow">Dataset builder</p>
        <h2>Upload videos &amp; extract hand landmarks</h2>
        <p className="batch-intro">
          Add clips (filename prefix becomes the label, e.g. <code>eat_001.mov</code> → “eat”),
          extract MediaPipe landmarks, check whether each clip is good for modeling, then export.
          Everything runs in your browser — nothing is uploaded.
        </p>
      </div>

      <div
        className="batch-dropzone"
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          addFiles(event.dataTransfer.files);
        }}
      >
        <FileVideo size={26} />
        <strong>Drag clips here, or</strong>
        <div className="batch-add-actions">
          <button
            className="button secondary"
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={busy}
          >
            <FilePlus size={17} />
            Add file(s)
          </button>
          <button
            className="button secondary"
            type="button"
            onClick={() => folderInputRef.current?.click()}
            disabled={busy}
          >
            <FolderPlus size={17} />
            Add folder
          </button>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="video/*"
          multiple
          hidden
          onChange={(event) => {
            addFiles(event.target.files);
            event.target.value = "";
          }}
        />
        <input
          ref={folderInputRef}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            addFiles(event.target.files);
            event.target.value = "";
          }}
        />
      </div>

      {clips.length ? (
        <>
          <div className="batch-toolbar">
            <button
              className="button primary"
              type="button"
              onClick={processQueued}
              disabled={busy || queuedCount === 0}
            >
              <Wand2 size={17} />
              {isProcessing ? "Extracting…" : `Extract landmarks${queuedCount ? ` (${queuedCount})` : ""}`}
            </button>
            <div className="batch-summary">
              <span className="batch-chip good">
                <CheckCircle2 size={15} /> {verdictTotals.ready} ready
              </span>
              <span className="batch-chip warn">
                <AlertTriangle size={15} /> {verdictTotals.notReady} needs work
              </span>
              <span className="batch-chip muted">{clips.length} total</span>
            </div>
            <button className="button ghost" type="button" onClick={clearAll} disabled={busy}>
              <Trash2 size={16} />
              Clear
            </button>
          </div>

          <div className="batch-list">
            {clips.map((clip) => (
              <article className="batch-row" key={clip.id}>
                <div className="batch-row-main">
                  <FileVideo size={18} className="batch-row-icon" />
                  <div className="batch-row-name">
                    <strong title={clip.fileName}>{clip.fileName}</strong>
                    <span>{formatBytes(clip.file.size)}</span>
                  </div>
                </div>

                <label className="batch-inline-field">
                  <span>Label</span>
                  <input
                    value={clip.label}
                    onChange={(event) => updateClip(clip.id, { label: event.target.value })}
                    disabled={busy}
                  />
                </label>

                <label className="batch-inline-field">
                  <span>Hands</span>
                  <select
                    value={String(clip.expectedHands)}
                    onChange={(event) => changeExpectedHands(clip.id, event.target.value)}
                    disabled={busy}
                  >
                    <option value="auto">Auto</option>
                    <option value="1">1 hand</option>
                    <option value="2">2 hands</option>
                  </select>
                </label>

                <div className="batch-row-status">{renderStatus(clip)}</div>

                <div className="batch-row-actions">
                  <button
                    className="icon-toggle"
                    type="button"
                    title="Re-extract this clip"
                    onClick={() => reprocessClip(clip.id)}
                    disabled={busy}
                  >
                    <RefreshCw size={16} />
                  </button>
                  <button
                    className="icon-toggle"
                    type="button"
                    title="Remove"
                    onClick={() => removeClip(clip.id)}
                    disabled={busy}
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              </article>
            ))}
          </div>

          <div className="batch-export">
            <div className="panel-heading batch-export-heading">
              <p className="eyebrow">Export</p>
              <span>Available once clips are extracted.</span>
            </div>
            <div className="batch-export-actions">
              <button
                className="button secondary"
                type="button"
                onClick={() => runExport("colab")}
                disabled={!hasExportable || busy}
              >
                <FileJson size={17} />
                Colab landmark ZIP
              </button>
              <button
                className="button secondary"
                type="button"
                onClick={() => runExport("csv")}
                disabled={!hasExportable || busy}
              >
                <Sheet size={17} />
                Table 3 CSV
              </button>
              <button
                className="button secondary"
                type="button"
                onClick={() => runExport("overlay")}
                disabled={!hasExportable || busy}
                title="Re-encodes each clip in real time — slower for large batches"
              >
                <Film size={17} />
                {exporting === "overlay"
                  ? `Overlay videos… ${formatPercent(exportProgress)}`
                  : "Overlay videos ZIP (slow)"}
              </button>
            </div>
          </div>
        </>
      ) : (
        <div className="batch-empty">
          <Download size={26} />
          <strong>No clips added yet</strong>
          <span>Add gesture videos to extract landmarks and check dataset quality.</span>
        </div>
      )}
    </section>
  );
}

function renderStatus(clip: UploadedClip) {
  if (clip.status === "queued") return <span className="batch-state muted">Queued</span>;
  if (clip.status === "processing") {
    return <span className="batch-state">Extracting… {formatPercent(clip.progress)}</span>;
  }
  if (clip.status === "error") {
    return (
      <span className="batch-state bad" title={clip.error}>
        <XCircle size={15} /> {clip.error ?? "Failed"}
      </span>
    );
  }

  const qc = clip.qc;
  if (!qc) return <span className="batch-state muted">—</span>;

  return (
    <div className="batch-verdict">
      <span className="batch-rate">{(qc.detectionRate * 100).toFixed(0)}% detected</span>
      <span className={`batch-badge table4-${qc.table4}`}>{table4Label[qc.table4]}</span>
      <span className={`batch-badge nb-${qc.notebookStatus}`}>{qc.notebookStatus}</span>
      {qc.flags.length ? (
        <span className="batch-flags" title={qc.flags.join("\n")}>
          <AlertTriangle size={13} /> {qc.flags.length} note{qc.flags.length === 1 ? "" : "s"}
        </span>
      ) : null}
    </div>
  );
}
