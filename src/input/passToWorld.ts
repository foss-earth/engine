import { isSafariGestureSupported } from "./safariGestures";
import { WHEEL_GESTURE_IDLE_MS, watchWheelGestures } from "./wheelController";

/**
 * Input that no control on the page uses goes to the world behind it. A
 * two-finger swipe over a panel that cannot scroll that way, over the HUD
 * bar or over an instrument moves the camera as it would over the map, and a
 * pinch zooms it, whichever camera has the canvas: the globe's, a panorama's
 * or an application's. None of it reaches the browser, where a sideways
 * swipe went Back a page and a pinch zoomed the page.
 *
 * A control keeps what it uses. An element that scrolls along the swipe's
 * main axis keeps the swipe, and a listener that calls preventDefault keeps
 * the event. The first event of a gesture decides for the rest of it, as a
 * browser decides which element a scroll moves, so a camera swipe that
 * drifts over a panel moves the camera to its end, and a scroll that turns
 * sideways keeps scrolling. A pinch is never a control's, unless one
 * prevents it.
 *
 * The events are handed to the canvas as copies, with the pointer where it
 * was, so a zoom about the pointer zooms about the point of the world under
 * it, behind the panel.
 */

type Axis = "x" | "y";

/** Overflow values that let an element's content scroll. */
const SCROLLS = new Set(["auto", "scroll", "overlay"]);
/** What Safari's GestureEvent carries that the canvas's handlers read. */
const GESTURE_FIELDS = ["scale", "rotation", "clientX", "clientY", "screenX", "screenY", "altKey", "ctrlKey", "metaKey", "shiftKey"] as const;

/** Whether `element` scrolls along `axis`: it lets its content scroll that way, and has more than it shows. */
function scrollsAlong(element: Element, axis: Axis): boolean {
  const style = getComputedStyle(element);
  if (!SCROLLS.has(axis === "y" ? style.overflowY : style.overflowX)) return false;
  return axis === "y" ? element.scrollHeight > element.clientHeight + 1 : element.scrollWidth > element.clientWidth + 1;
}

/**
 * Whether the page uses a wheel event aimed at `target`: some element from
 * it up scrolls along the event's main axis, or it is a number field with
 * focus, whose value a browser may step with the wheel. A pinch, which a
 * browser sends as a wheel event with Ctrl held, scrolls nothing.
 */
export function pageUsesWheel(target: EventTarget | null, event: Pick<WheelEvent, "deltaX" | "deltaY" | "ctrlKey">): boolean {
  if (event.ctrlKey) return false;
  const axis: Axis = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? "x" : "y";
  const doc = target instanceof Node ? target.ownerDocument : null;
  for (let element = target instanceof Element ? target : null; element && element !== doc?.documentElement; element = element.parentElement) {
    if (element === doc?.activeElement && element instanceof HTMLInputElement && element.type === "number") return true;
    if (scrollsAlong(element, axis)) return true;
  }
  return false;
}

function copyWheel(event: WheelEvent): WheelEvent {
  return new WheelEvent("wheel", {
    bubbles: true,
    cancelable: true,
    composed: true,
    deltaX: event.deltaX,
    deltaY: event.deltaY,
    deltaZ: event.deltaZ,
    deltaMode: event.deltaMode,
    clientX: event.clientX,
    clientY: event.clientY,
    screenX: event.screenX,
    screenY: event.screenY,
    ctrlKey: event.ctrlKey,
    shiftKey: event.shiftKey,
    altKey: event.altKey,
    metaKey: event.metaKey,
    button: event.button,
    buttons: event.buttons,
  });
}

/** Safari's GestureEvent cannot be constructed, so the copy is an Event carrying its fields. */
function copyGesture(event: Event): Event {
  const copy = new Event(event.type, { bubbles: true, cancelable: true, composed: true });
  for (const field of GESTURE_FIELDS) {
    if (field in event) Object.defineProperty(copy, field, { value: (event as unknown as Record<string, unknown>)[field] });
  }
  return copy;
}

export interface PassToWorldOptions {
  /** Whether Safari's gesture events are forwarded too: where the browser sends them. */
  safariGestures?: boolean;
}

/**
 * Starts handing the canvas the wheel and gesture events that no control
 * over it uses. Returns a stop.
 */
export function passUnusedInputToWorld(canvas: HTMLCanvasElement, options: PassToWorldOptions = {}): () => void {
  const doc = canvas.ownerDocument;
  const isCanvasEvent = (event: Event): boolean => {
    const target = event.target as Node | null;
    return target === canvas || (target !== null && canvas.contains(target));
  };
  // Every wheel event the canvas gets, its own and the copies, seen before any handler can stop it.
  const world = watchWheelGestures(canvas);
  /** When the page last kept a wheel event, `performance.now()`. */
  let pageKeptAt = Number.NEGATIVE_INFINITY;

  const onWheel = (event: WheelEvent): void => {
    if (isCanvasEvent(event)) return;
    const now = performance.now();
    if (event.defaultPrevented || now - pageKeptAt <= WHEEL_GESTURE_IDLE_MS) {
      pageKeptAt = now;
      return;
    }
    const worldsGesture = now - world.lastEventMs() <= WHEEL_GESTURE_IDLE_MS;
    if (!worldsGesture && pageUsesWheel(event.target, event)) {
      pageKeptAt = now;
      return;
    }
    event.preventDefault();
    canvas.dispatchEvent(copyWheel(event));
  };

  const gestureTypes = (options.safariGestures ?? isSafariGestureSupported()) ? ["gesturestart", "gesturechange", "gestureend"] : [];
  const onGesture = (event: Event): void => {
    if (isCanvasEvent(event) || event.defaultPrevented) return;
    event.preventDefault();
    canvas.dispatchEvent(copyGesture(event));
  };

  doc.addEventListener("wheel", onWheel, { passive: false });
  for (const type of gestureTypes) doc.addEventListener(type, onGesture, { passive: false });
  return () => {
    doc.removeEventListener("wheel", onWheel);
    for (const type of gestureTypes) doc.removeEventListener(type, onGesture);
    world.dispose();
  };
}
