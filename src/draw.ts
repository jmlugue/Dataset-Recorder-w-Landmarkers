import type { DrawingUtils, NormalizedLandmark } from "@mediapipe/tasks-vision";

export type HandConnection = { start: number; end: number };

// Draw the current video frame onto a canvas, optionally mirrored (front-camera style).
export function drawVideoFrame(
  context: CanvasRenderingContext2D,
  source: CanvasImageSource,
  width: number,
  height: number,
  mirrored: boolean
) {
  context.save();
  if (mirrored) {
    context.translate(width, 0);
    context.scale(-1, 1);
  }
  context.drawImage(source, 0, 0, width, height);
  context.restore();
}

// Draw the MakaLearn hand skeleton (teal connectors, blue joints) for every detected hand.
export function drawHandLandmarks(
  drawingUtils: DrawingUtils,
  hands: NormalizedLandmark[][],
  connections: HandConnection[],
  width: number
) {
  const lineWidth = Math.max(3, width * 0.004);
  hands.forEach((hand) => {
    drawingUtils.drawConnectors(hand, connections, { color: "#14b8a6", lineWidth });
    drawingUtils.drawLandmarks(hand, {
      color: "#ffffff",
      fillColor: "#2563eb",
      lineWidth: 2,
      radius: lineWidth
    });
  });
}

export function roundRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
) {
  context.beginPath();
  context.moveTo(x + radius, y);
  context.arcTo(x + width, y, x + width, y + height, radius);
  context.arcTo(x + width, y + height, x, y + height, radius);
  context.arcTo(x, y + height, x, y, radius);
  context.arcTo(x, y, x + width, y, radius);
  context.closePath();
}
