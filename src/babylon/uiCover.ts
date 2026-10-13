/** A rectangle in viewport CSS pixels, origin at the top left. */
export interface CssBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A rectangle in clip space. (x, y) is its bottom-left corner; a unit quad grows by (w, h). */
export interface ClipRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function intersectBoxes(a: CssBox, b: CssBox): CssBox | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const width = Math.min(a.x + a.width, b.x + b.width) - x;
  const height = Math.min(a.y + a.height, b.y + b.height) - y;
  if (width < 1 || height < 1) return null;
  return { x, y, width, height };
}

/**
 * The part of `rect` that lies on `canvas`, as a clip-space quad.
 * Clip y points up, so a box at the top of the canvas sits at y near +1.
 */
export function cssRectToClip(rect: CssBox, canvas: CssBox): ClipRect | null {
  if (canvas.width <= 0 || canvas.height <= 0) return null;
  const covered = intersectBoxes(rect, canvas);
  if (!covered) return null;
  const left = ((covered.x - canvas.x) / canvas.width) * 2 - 1;
  const right = ((covered.x - canvas.x + covered.width) / canvas.width) * 2 - 1;
  const top = 1 - ((covered.y - canvas.y) / canvas.height) * 2;
  const bottom = 1 - ((covered.y - canvas.y + covered.height) / canvas.height) * 2;
  return { x: left, y: bottom, w: right - left, h: top - bottom };
}
