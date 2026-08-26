import type { RecordingMetadata } from "./types";

export function createRecordingId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return `recording-${Date.now()}-${Math.round(Math.random() * 100000)}`;
}

export function createFileBaseName(input: {
  label: string;
  participantId: string;
  takeNumber: string;
  cameraView: string;
  createdAt: Date;
}) {
  const datePart = input.createdAt.toISOString().replace(/:/g, "-").replace(/\..+/, "");
  return [
    toFileSegment(input.label || "unlabeled"),
    toFileSegment(input.participantId || "participant"),
    `take-${toFileSegment(input.takeNumber || "1")}`,
    toFileSegment(input.cameraView || "view"),
    datePart
  ].join("_");
}

export function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadMetadata(metadata: RecordingMetadata, fileBaseName: string) {
  const blob = new Blob([JSON.stringify(metadata, null, 2)], {
    type: "application/json"
  });
  downloadBlob(blob, `${fileBaseName}.json`);
}

function toFileSegment(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

