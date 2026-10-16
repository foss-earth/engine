import type { DynamicTexture } from "@babylonjs/core";
import type { CanvasTextureDevicePorts } from "@foss-earth/renderer/babylon";
import { DEFAULT_DOT_TEXTURE_SIZE, type MarkerStyle, rgbToCss } from "./types.js";

/** One cell of the X the navigation anchors paint on coloured ink the ground hides, in CSS pixels. */
const OBSCURED_X_CELL_PX = 4;

/** The anchors' X, tiled across the cell. Callers clip this to the fill. */
function paintObscuredX(ctx: CanvasRenderingContext2D, cellSize: number, sizePx: number): void {
  const step = Math.max(3, cellSize * OBSCURED_X_CELL_PX / sizePx);
  ctx.strokeStyle = "rgba(15, 23, 42, 0.9)";
  // A hair thicker than the anchors' 0.6px stroke, so the lattice still reads after the sprite texture is scaled.
  ctx.lineWidth = Math.max(1.5, cellSize * 1.15 / sizePx);
  ctx.lineCap = "round";
  ctx.beginPath();
  for (let y = -step; y < cellSize + step; y += step) {
    for (let x = -step; x < cellSize + step; x += step) {
      ctx.moveTo(x, y);
      ctx.lineTo(x + step, y + step);
      ctx.moveTo(x + step, y);
      ctx.lineTo(x, y + step);
    }
  }
  ctx.stroke();
}

export function drawCircleAtlasCell(
  ctx: CanvasRenderingContext2D,
  style: MarkerStyle,
  originX: number,
  originY: number,
  cellSize: number = DEFAULT_DOT_TEXTURE_SIZE,
): void {
  const r = cellSize / 2;
  const strokeWidth = style.strokeWidth ?? 7;
  const inset = style.strokeWidth === 0 ? 1 : 5;
  ctx.save();
  ctx.translate(originX, originY);
  ctx.clearRect(0, 0, cellSize, cellSize);
  ctx.beginPath();
  ctx.arc(r, r, Math.max(1, r - inset), 0, Math.PI * 2);
  ctx.fillStyle = rgbToCss(style.fill);
  ctx.fill();
  if (strokeWidth > 0) {
    ctx.lineWidth = strokeWidth;
    ctx.strokeStyle = rgbToCss(style.stroke);
    ctx.stroke();
  }
  if (typeof style.obscuredSizePx === "number" && style.obscuredSizePx > 0) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(r, r, Math.max(1, r - inset - strokeWidth / 2), 0, Math.PI * 2);
    ctx.clip();
    paintObscuredX(ctx, cellSize, style.obscuredSizePx);
    ctx.restore();
  }
  ctx.restore();
}

/**
 * Build a horizontal dynamic-texture atlas of circular markers. Each style in
 * `styles` becomes one cell; the index of a style in the array is the
 * `sprite.cellIndex` to use when rendering that marker.
 */
export function makeCircularMarkerAtlas(
  device: CanvasTextureDevicePorts,
  name: string,
  styles: MarkerStyle[],
  cellSize: number = DEFAULT_DOT_TEXTURE_SIZE,
): DynamicTexture {
  const width = cellSize * Math.max(1, styles.length);
  const tex = device.createTexture({ name, width, height: cellSize, mipmaps: false });
  try {
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  ctx.clearRect(0, 0, width, cellSize);
  styles.forEach((style, idx) => {
    drawCircleAtlasCell(ctx, style, idx * cellSize, 0, cellSize);
  });
  tex.hasAlpha = true;
  device.updateTexture(tex, false);
  return tex;
  } catch (error) { tex.dispose(); throw error; }
}
