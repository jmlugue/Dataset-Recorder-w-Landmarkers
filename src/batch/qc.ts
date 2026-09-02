import type {
  ClipExtraction,
  ClipQc,
  ExpectedHands,
  NotebookStatus,
  Table4Verdict
} from "../types";

// Manuscript Table 4 detection-rate bands (percent).
const TABLE4_ACCEPT = 95;
const TABLE4_ACCEPT_IF_COMPLETE = 90;
const TABLE4_REVIEW = 80;

// Notebook classify() cutoffs (fraction of frames with any hand).
const NB_MIN_DETECTED_FRAMES = 8;
const NB_FAIL_COVERAGE = 0.4;
const NB_WARN_COVERAGE = 0.6;

// Manuscript recording-duration guideline.
const MIN_DURATION_SEC = 3;
const MAX_DURATION_SEC = 5;

function requiredCountForFrame(handCount: number, expectedHands: ExpectedHands): boolean {
  if (expectedHands === 2) return handCount >= 2;
  if (expectedHands === 1) return handCount >= 1;
  return handCount >= 1; // auto
}

function table4Verdict(detectionRatePercent: number): Table4Verdict {
  if (detectionRatePercent >= TABLE4_ACCEPT) return "accept";
  if (detectionRatePercent >= TABLE4_ACCEPT_IF_COMPLETE) return "accept-if-complete";
  if (detectionRatePercent >= TABLE4_REVIEW) return "review";
  return "re-record";
}

// Reproduces the notebook's classify(total, detected) exactly, using the any-hand count.
function notebookStatus(
  frameCount: number,
  anyHandFrameCount: number,
  coverage: number
): { status: NotebookStatus; reason: string } {
  if (frameCount === 0) return { status: "fail", reason: "unreadable video (no frames decoded)" };
  if (anyHandFrameCount < NB_MIN_DETECTED_FRAMES) {
    return { status: "fail", reason: "hand detected in too few frames" };
  }
  if (coverage < NB_FAIL_COVERAGE) {
    return { status: "fail", reason: "low coverage (lighting / distance / hand out of frame)" };
  }
  if (coverage < NB_WARN_COVERAGE) return { status: "warn", reason: "usable but low coverage" };
  return { status: "pass", reason: "ok" };
}

export function computeQc(extraction: ClipExtraction, expectedHands: ExpectedHands): ClipQc {
  const frames = extraction.frames;
  const frameCount = frames.length;
  let anyHandFrameCount = 0;
  let requiredHandFrameCount = 0;
  let maxHandsSeen = 0;

  for (const frame of frames) {
    if (frame.handCount >= 1) anyHandFrameCount += 1;
    if (requiredCountForFrame(frame.handCount, expectedHands)) requiredHandFrameCount += 1;
    if (frame.handCount > maxHandsSeen) maxHandsSeen = frame.handCount;
  }

  const coverage = frameCount ? anyHandFrameCount / frameCount : 0;
  const detectionRate = frameCount ? requiredHandFrameCount / frameCount : 0;
  const durationSec = extraction.fps ? frameCount / extraction.fps : 0;

  const nb = notebookStatus(frameCount, anyHandFrameCount, coverage);

  const flags: string[] = [];
  if (expectedHands !== "auto" && maxHandsSeen < expectedHands) {
    flags.push(`Fewer hands than expected (saw ${maxHandsSeen}, need ${expectedHands})`);
  }
  if (expectedHands !== "auto" && maxHandsSeen > expectedHands) {
    flags.push(`Extra hand detected in some frames (saw ${maxHandsSeen})`);
  }
  if (anyHandFrameCount < NB_MIN_DETECTED_FRAMES) {
    flags.push("Too few usable frames with a hand");
  }
  if (durationSec && (durationSec < MIN_DURATION_SEC || durationSec > MAX_DURATION_SEC)) {
    flags.push(`Duration ${durationSec.toFixed(1)}s is outside the 3–5s guideline`);
  }

  return {
    frameCount,
    anyHandFrameCount,
    requiredHandFrameCount,
    coverage,
    detectionRate,
    maxHandsSeen,
    durationSec,
    table4: table4Verdict(detectionRate * 100),
    notebookStatus: nb.status,
    notebookReason: nb.reason,
    flags
  };
}

export const table4Label: Record<Table4Verdict, string> = {
  accept: "Accept",
  "accept-if-complete": "Accept if complete",
  review: "Review",
  "re-record": "Re-record"
};

// Whether a clip should be included when building the training dataset (fail => excluded,
// matching the notebook, which skips status === "fail").
export function isModelReady(qc: ClipQc): boolean {
  return qc.notebookStatus !== "fail" && qc.table4 !== "re-record";
}
