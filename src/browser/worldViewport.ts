/**
 * The world's part of a canvas that other surfaces share. The canvas fills the
 * shell; the host says where the world is on it, the frame draws the world
 * there, and screen-to-world conversions, screen rates and input use the same
 * rectangle.
 */

/** In CSS pixels from the top-left corner of the canvas's box. */
export interface WorldViewportRect { x: number; y: number; width: number; height: number }

/** Where the world is on the canvas now, or null for all of it. Read at most once a frame, so it should not force layout. */
export type WorldViewportSource = () => WorldViewportRect | null;

/** A canvas, or the part of one a port passes for heights alone. */
type CanvasBox = Pick<HTMLCanvasElement, "clientHeight"> & Partial<Pick<HTMLCanvasElement, "clientWidth">>;

interface Entry { source: WorldViewportSource | null; drawn: WorldViewportRect | null }
const entries = new WeakMap<object, Entry>();

function entryOf(canvas: object): Entry {
  let entry = entries.get(canvas);
  if (!entry) {
    entry = { source: null, drawn: null };
    entries.set(canvas, entry);
  }
  return entry;
}

/** Says where the world is on `canvas`; null gives it the whole canvas again. Returns a function that removes this source. */
export function setWorldViewportSource(canvas: HTMLCanvasElement, source: WorldViewportSource | null): () => void {
  const entry = entryOf(canvas);
  entry.source = source;
  entry.drawn = null;
  return () => {
    if (entry.source !== source) return;
    entry.source = null;
    entry.drawn = null;
  };
}

/** The rectangle the source asks for, inside the canvas box; the whole box without a source. */
export function requestedWorldViewport(canvas: CanvasBox): WorldViewportRect {
  const width = Math.max(0, canvas.clientWidth ?? 0), height = Math.max(0, canvas.clientHeight);
  const asked = entries.get(canvas)?.source?.() ?? null;
  if (!asked || ![asked.x, asked.y, asked.width, asked.height].every(Number.isFinite)) return { x: 0, y: 0, width, height };
  const left = Math.min(Math.max(asked.x, 0), width), top = Math.min(Math.max(asked.y, 0), height);
  const right = Math.min(Math.max(asked.x + asked.width, left), width);
  const bottom = Math.min(Math.max(asked.y + asked.height, top), height);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** Records what a frame drew, so input until the next frame uses the same rectangle. */
export function commitWorldViewport(canvas: HTMLCanvasElement, drawn: WorldViewportRect | null): void {
  entryOf(canvas).drawn = drawn;
}

/** Where the world was last drawn, or where it is asked for before a frame draws it. */
export function worldViewportRect(canvas: CanvasBox): WorldViewportRect {
  return entries.get(canvas)?.drawn ?? requestedWorldViewport(canvas);
}

/** The world's height in CSS pixels, for screen rates such as metres per pixel; 0 before layout. */
export function worldViewportHeight(canvas: CanvasBox): number {
  return worldViewportRect(canvas).height;
}

/** Where the world is on the page, in client pixels, through any CSS transform of the canvas.
 * `box` is the canvas's layout when the caller already read it, so a frame does not read it twice. */
export function worldViewportClientRect(canvas: HTMLCanvasElement, box: { left: number; top: number; width: number; height: number } = canvas.getBoundingClientRect()): { left: number; top: number; width: number; height: number } {
  if (!entries.get(canvas)?.source) return { left: box.left, top: box.top, width: box.width, height: box.height };
  const scaleX = canvas.clientWidth > 0 ? box.width / canvas.clientWidth : 1;
  const scaleY = canvas.clientHeight > 0 ? box.height / canvas.clientHeight : 1;
  const rect = worldViewportRect(canvas);
  return { left: box.left + rect.x * scaleX, top: box.top + rect.y * scaleY, width: rect.width * scaleX, height: rect.height * scaleY };
}

/** True when a client point falls on the world, not on another surface's part of the canvas. */
export function isInWorldViewport(canvas: HTMLCanvasElement, clientX: number, clientY: number): boolean {
  if (!entries.get(canvas)?.source) return true;
  const rect = worldViewportClientRect(canvas);
  return clientX >= rect.left && clientX < rect.left + rect.width && clientY >= rect.top && clientY < rect.top + rect.height;
}

const STARTS = ["pointerdown", "mousedown", "touchstart", "wheel", "click", "dblclick", "contextmenu"] as const;
const POINTER_FOLLOWS = ["pointermove", "pointerup", "pointercancel", "mousemove", "mouseup"] as const;
const TOUCH_FOLLOWS = ["touchmove", "touchend", "touchcancel"] as const;

/**
 * Keeps input that lands on the canvas outside the world from reaching the
 * world's handlers, which all listen on the canvas. It listens first, in the
 * capture phase on the document, and stops a press, touch or wheel there and
 * the rest of that pointer's or finger's gesture. Presses on the world pass.
 */
export function gateWorldInput(canvas: HTMLCanvasElement): () => void {
  const doc = canvas.ownerDocument;
  const blockedPointers = new Set<number>();
  const blockedTouches = new Set<number>();
  let blockedMouse = false;
  const onStart = (event: Event): void => {
    if (event.target !== canvas) return;
    if (event.type === "touchstart") {
      const touches = Array.from((event as TouchEvent).changedTouches ?? []);
      const outside = touches.filter(touch => !isInWorldViewport(canvas, touch.clientX, touch.clientY));
      for (const touch of outside) blockedTouches.add(touch.identifier);
      if (outside.length === 0 || outside.length < touches.length) return;
    } else {
      const point = event as MouseEvent;
      if (isInWorldViewport(canvas, point.clientX, point.clientY)) return;
      if (event.type === "pointerdown") blockedPointers.add((event as PointerEvent).pointerId);
      if (event.type === "mousedown") blockedMouse = true;
    }
    // The browser would zoom the page or scroll, as it never does over the world.
    if (event.type === "wheel" || event.type === "touchstart") event.preventDefault();
    event.stopImmediatePropagation();
  };
  const onPointerFollow = (event: Event): void => {
    if (event.target !== canvas) return;
    const pointer = event as PointerEvent;
    const blocked = event.type.startsWith("pointer") ? blockedPointers.has(pointer.pointerId) : blockedMouse;
    if (!blocked) return;
    if (event.type === "pointerup" || event.type === "pointercancel") blockedPointers.delete(pointer.pointerId);
    if (event.type === "mouseup") blockedMouse = false;
    event.stopImmediatePropagation();
  };
  const onTouchFollow = (event: Event): void => {
    if (event.target !== canvas) return;
    const touches = Array.from((event as TouchEvent).changedTouches ?? []);
    if (touches.length === 0 || !touches.every(touch => blockedTouches.has(touch.identifier))) return;
    if (event.type !== "touchmove") for (const touch of touches) blockedTouches.delete(touch.identifier);
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const options = { capture: true, passive: false } as const;
  for (const type of STARTS) doc.addEventListener(type, onStart, options);
  for (const type of POINTER_FOLLOWS) doc.addEventListener(type, onPointerFollow, options);
  for (const type of TOUCH_FOLLOWS) doc.addEventListener(type, onTouchFollow, options);
  return () => {
    for (const type of STARTS) doc.removeEventListener(type, onStart, options);
    for (const type of POINTER_FOLLOWS) doc.removeEventListener(type, onPointerFollow, options);
    for (const type of TOUCH_FOLLOWS) doc.removeEventListener(type, onTouchFollow, options);
  };
}
