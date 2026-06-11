/**
 * Anchor pan overlay: grab point on the ground + line to the cursor.
 * Colors follow `data-theme` / `.dark` via globe.css.
 */
export interface AnchorPanDebugOverlay {
  update(anchorClientX: number, anchorClientY: number, cursorClientX: number, cursorClientY: number): void;
  hide(): void;
  destroy(): void;
}

export function attachAnchorPanDebugOverlay(canvas: HTMLCanvasElement): AnchorPanDebugOverlay {
  const host = canvas.parentElement ?? document.body;
  const root = document.createElement("div");
  root.setAttribute("data-foss-earth-anchor-pan-debug", "1");
  root.style.cssText = [
    "position:absolute",
    "inset:0",
    "pointer-events:none",
    "z-index:50",
    "overflow:visible",
  ].join(";");

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", "100%");
  svg.setAttribute("height", "100%");
  svg.style.cssText = "position:absolute;inset:0;overflow:visible";

  const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
  line.setAttribute("class", "anchor-pan-line");

  const anchorDot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  anchorDot.setAttribute("class", "anchor-pan-dot");
  anchorDot.setAttribute("r", "6");

  svg.append(line, anchorDot);
  root.append(svg);
  root.hidden = true;
  host.append(root);

  function toCanvasLocal(clientX: number, clientY: number): { x: number; y: number } {
    const rect = canvas.getBoundingClientRect();
    return {
      x: clientX - rect.left,
      y: clientY - rect.top,
    };
  }

  function update(
    anchorClientX: number,
    anchorClientY: number,
    cursorClientX: number,
    cursorClientY: number,
  ): void {
    const anchor = toCanvasLocal(anchorClientX, anchorClientY);
    const cursor = toCanvasLocal(cursorClientX, cursorClientY);
    root.hidden = false;
    line.setAttribute("x1", String(anchor.x));
    line.setAttribute("y1", String(anchor.y));
    line.setAttribute("x2", String(cursor.x));
    line.setAttribute("y2", String(cursor.y));
    anchorDot.setAttribute("cx", String(anchor.x));
    anchorDot.setAttribute("cy", String(anchor.y));
  }

  function hide(): void {
    root.hidden = true;
  }

  function destroy(): void {
    root.remove();
  }

  return { update, hide, destroy };
}
