/**
 * Where zoom and rotation act: the point under the pointer, the start of a
 * two-finger gesture, the compass target or a pinned point, chosen per input
 * family (`input.<family>.zoomAnchor`, `input.<family>.orbitPivot`).
 *
 * A gesture resolves its anchors once, when it starts, and keeps them, copied,
 * through its glide. These are the browser-neutral parts: the preferences,
 * what a gesture asks for and what it gets. Picking a point needs the camera
 * and the displayed surface, and lives with them.
 * See docs/proposals/navigation-anchors.md in foss-earth/research.
 */
import type { EcefCoord } from "../camera/cameraMath.js";

/** The input families that choose their own anchors. Keys, controllers and on-screen buttons are `nonPointer`. */
export type AnchorFamily = "mouse" | "trackpad" | "touch" | "nonPointer";
/** The two operations that act about a point. Pan has no anchor of this kind. */
export type AnchorOperation = "zoom" | "orbit";

/** Mouse and trackpad: the point under the pointer, the compass target or the pinned point. */
export type PointerAnchorChoice = "pointer" | "target" | "pinned";
/** Touch: the point under the first two fingers' midpoint when they land. */
export type GestureAnchorChoice = "gesture" | "target" | "pinned";
/** Keys, controllers and buttons have no pointing position. */
export type NonPointerAnchorChoice = "target" | "pinned";
export type AnchorChoice = PointerAnchorChoice | GestureAnchorChoice | NonPointerAnchorChoice;

export interface NavigationAnchorPreferences {
  readonly mouse: { readonly zoom: PointerAnchorChoice; readonly orbit: PointerAnchorChoice };
  readonly trackpad: { readonly zoom: PointerAnchorChoice; readonly orbit: PointerAnchorChoice };
  readonly touch: { readonly zoom: GestureAnchorChoice; readonly orbit: GestureAnchorChoice };
  readonly nonPointer: { readonly zoom: NonPointerAnchorChoice; readonly orbit: NonPointerAnchorChoice };
}

export const ANCHOR_FAMILIES: readonly AnchorFamily[] = ["mouse", "trackpad", "touch", "nonPointer"];
export const ANCHOR_OPERATIONS: readonly AnchorOperation[] = ["zoom", "orbit"];

/** The choices each family offers, in the order the controls show them. */
export const NAVIGATION_ANCHOR_CHOICES: { readonly [F in AnchorFamily]: readonly NavigationAnchorPreferences[F]["zoom"][] } = {
  mouse: ["pointer", "target", "pinned"],
  trackpad: ["pointer", "target", "pinned"],
  touch: ["gesture", "target", "pinned"],
  nonPointer: ["target", "pinned"],
};

/**
 * The defaults, with one source: the settings catalogue reads them, and so
 * does an input controller given no preferences. Pointing devices act where
 * the person points; keys and controllers about the compass target.
 */
export const DEFAULT_NAVIGATION_ANCHORS: NavigationAnchorPreferences = Object.freeze({
  mouse: Object.freeze({ zoom: "pointer", orbit: "pointer" }),
  trackpad: Object.freeze({ zoom: "pointer", orbit: "pointer" }),
  touch: Object.freeze({ zoom: "gesture", orbit: "gesture" }),
  nonPointer: Object.freeze({ zoom: "target", orbit: "target" }),
});

/** The parameter holding a family's choice for an operation: `input.mouse.zoomAnchor`, `input.touch.orbitPivot`. */
export function navigationAnchorSettingId(family: AnchorFamily, operation: AnchorOperation): string {
  return `input.${family}.${operation === "zoom" ? "zoomAnchor" : "orbitPivot"}`;
}

/** The eight parameters, family by family, zoom before rotation. */
export const NAVIGATION_ANCHOR_SETTING_IDS: readonly string[] = ANCHOR_FAMILIES.flatMap(family => ANCHOR_OPERATIONS.map(operation => navigationAnchorSettingId(family, operation)));

/** Whether markers show the points zoom and rotation act about. */
export const SHOW_NAVIGATION_ANCHORS_ID = "input.showNavigationAnchors";

export type NavigationAnchorPreferencesInput = { readonly [F in AnchorFamily]?: { readonly zoom?: unknown; readonly orbit?: unknown } };

/** Preferences with every family and operation present; a missing or unknown choice is the default. */
export function normalizeNavigationAnchors(input?: NavigationAnchorPreferencesInput | null): NavigationAnchorPreferences {
  const pick = <F extends AnchorFamily>(family: F, operation: AnchorOperation): NavigationAnchorPreferences[F]["zoom"] => {
    const value = input?.[family]?.[operation];
    const allowed = NAVIGATION_ANCHOR_CHOICES[family] as readonly unknown[];
    return (allowed.includes(value) ? value : DEFAULT_NAVIGATION_ANCHORS[family][operation]) as NavigationAnchorPreferences[F]["zoom"];
  };
  return {
    mouse: { zoom: pick("mouse", "zoom"), orbit: pick("mouse", "orbit") },
    trackpad: { zoom: pick("trackpad", "zoom"), orbit: pick("trackpad", "orbit") },
    touch: { zoom: pick("touch", "zoom"), orbit: pick("touch", "orbit") },
    nonPointer: { zoom: pick("nonPointer", "zoom"), orbit: pick("nonPointer", "orbit") },
  };
}

/** Preferences from setting values by id, such as a registry's: `read(id)` may return anything. */
export function navigationAnchorsFromSettings(read: (id: string) => unknown): NavigationAnchorPreferences {
  const input: Record<string, { zoom?: unknown; orbit?: unknown }> = {};
  for (const family of ANCHOR_FAMILIES) {
    input[family] = { zoom: read(navigationAnchorSettingId(family, "zoom")), orbit: read(navigationAnchorSettingId(family, "orbit")) };
  }
  return normalizeNavigationAnchors(input);
}

/** Where a resolved anchor came from: the displayed surface, the WGS84 ellipsoid, the compass target, or the pin. */
export type AnchorSource = "surface" | "ellipsoid" | "target" | "pinned";

/** Why the compass target stands in for what was asked for. */
export type AnchorFallback =
  | "no-pin"
  | "pin-behind"
  | "pin-beyond-horizon"
  | "pin-too-near"
  | "pin-invalid"
  | "no-pointer"
  | "missed"
  | "tracking"
  | "unsupported";

/** What the controls and diagnostics say about a fallback. The first three are the specification's words. */
export const ANCHOR_FALLBACK_MESSAGES: { readonly [K in AnchorFallback]: string } = {
  "no-pin": "No pinned point; using compass target",
  "pin-behind": "Pinned point behind camera",
  "pin-beyond-horizon": "Pinned point beyond horizon",
  "pin-too-near": "Pinned point at the camera; using compass target",
  "pin-invalid": "Pinned point not usable; using compass target",
  "no-pointer": "No pointer position; using compass target",
  "missed": "Nothing under the pointer; using compass target",
  "tracking": "Following a tracked point: it is the centre of zoom and rotation",
  "unsupported": "This camera zooms and turns about its centre only",
};

/**
 * One operation's anchor for one gesture, resolved when it started and kept,
 * copied, through its glide. A null `point` is the compass target: the
 * camera's own orbit target, which follows the ground as it always has.
 */
export interface NavigationAnchor {
  /** Increases with every acquisition: operations that acquired together share it. */
  readonly session: number;
  /** Who held navigation when it was acquired: "globe" for the globe's own input. */
  readonly owner: string;
  readonly family: AnchorFamily;
  readonly operation: AnchorOperation;
  /** The preference it was resolved for. */
  readonly requested: AnchorChoice;
  readonly source: AnchorSource;
  /** ECEF metres, copied; null for the compass target. */
  readonly point: Readonly<EcefCoord> | null;
  /** The displayed surface's revision when picked from it, for diagnostics. */
  readonly surfaceRevision: number | null;
  /** Why the compass target stands in for the choice, or null. */
  readonly fallback: AnchorFallback | null;
}

/**
 * What a gesture asks for when it starts: its family, the operations it may
 * do, and the client point the person indicated (CSS pixels, as `clientX`
 * and `clientY`), or null when there is none. Zero is a coordinate like any
 * other: whether there is a point is said, not guessed.
 */
export interface AnchorRequest<TCanvas = unknown> {
  readonly family: AnchorFamily;
  readonly operations: readonly AnchorOperation[];
  readonly client: { readonly x: number; readonly y: number } | null;
  /** The canvas `client` is over, for a target with more than one. */
  readonly canvas?: TCanvas;
  /**
   * Whether the gesture holds its anchors until it calls `releaseAnchors`, as
   * a drag or a touch pair does while it is down. A wheel's events do not.
   */
  readonly hold?: boolean;
  /**
   * A press that may still turn out to be a click, or fingers that may lift
   * without moving: its anchors are picked now, where it began, but neither
   * shown nor reported until the gesture holds them with `holdAnchors`.
   */
  readonly candidate?: boolean;
  /**
   * The choices the gesture latched when it began, used instead of the
   * current ones: a wheel gesture that picks again where the pointer has
   * moved keeps what it began with.
   */
  readonly prefer?: { readonly [O in AnchorOperation]?: AnchorChoice };
}

/** The anchors a gesture acquired, by operation. */
export type AnchorAcquisition = { readonly [O in AnchorOperation]?: NavigationAnchor };

/**
 * Why an anchored zoom or orbit did not move as asked: a limit or the camera's
 * place held it (`distance-limit`, `tilt-limit`, `pole`), the point was not in
 * front of the camera (`not-ahead`), or the request or pose was not usable.
 */
export type AnchoredMotionConstraint = "distance-limit" | "tilt-limit" | "pole" | "not-ahead" | "invalid";

/** What an anchored zoom or orbit did: moved, perhaps less than asked, or nothing, and why. */
export interface AnchoredMotionResult {
  moved: boolean;
  constrained: AnchoredMotionConstraint | null;
}

/**
 * A glide's motion for one 60 Hz frame, as the inertial controller keeps it:
 * pan in screen pixels, orbit in degrees about its anchor, and zoom as the
 * natural logarithm of the distance to its anchor. A null anchor is the
 * compass target.
 */
export interface GlideMotion {
  readonly pan: { readonly x: number; readonly y: number; readonly canvasHeight: number };
  readonly orbit: { readonly pitch: number; readonly heading: number; readonly anchor: NavigationAnchor | null };
  readonly zoom: { readonly log: number; readonly anchor: NavigationAnchor | null };
}

/** The same point, or both none. */
export function samePoint(p: Readonly<EcefCoord> | null | undefined, q: Readonly<EcefCoord> | null | undefined): boolean {
  if (!p || !q) return !p && !q;
  return p.x === q.x && p.y === q.y && p.z === q.z;
}

/** The same two points, or both the compass target: one combined step can keep both where they are. */
export function sameAnchorPoint(a: NavigationAnchor | null | undefined, b: NavigationAnchor | null | undefined): boolean {
  return samePoint(a?.point, b?.point);
}

/** The two named sets of choices: the defaults, and everything about the compass target. Each sets the eight choices and nothing else. */
export const NAVIGATION_ANCHOR_PRESET_VALUES: Readonly<{ pointerAndTouch: Readonly<Record<string, string>>; compassCentered: Readonly<Record<string, string>> }> = Object.freeze({
  pointerAndTouch: Object.freeze(Object.fromEntries(ANCHOR_FAMILIES.flatMap(family => ANCHOR_OPERATIONS.map(operation =>
    [navigationAnchorSettingId(family, operation), DEFAULT_NAVIGATION_ANCHORS[family][operation]])))),
  compassCentered: Object.freeze(Object.fromEntries(NAVIGATION_ANCHOR_SETTING_IDS.map(id => [id, "target"]))),
});

/** A point pinned for this globe session: never exported, never in the URL, gone with the runtime. */
export interface PinnedPoint {
  readonly point: Readonly<EcefCoord>;
  readonly latDeg: number;
  readonly lonDeg: number;
  /** WGS84 ellipsoid height, metres. */
  readonly heightMeters: number;
  /** Picked on the displayed surface or the ellipsoid, or the compass target pinned as it was. */
  readonly source: "surface" | "ellipsoid" | "target";
  readonly surfaceRevision: number | null;
}

/** Pick point: off, waiting for a click or tap, or waiting again after one found no surface. */
export type PointSelectionState = "off" | "armed" | "missed";

/** What the controls and markers show. */
export interface NavigationAnchorStatus {
  readonly pin: PinnedPoint | null;
  readonly selection: PointSelectionState;
  /** Why picking or pinning is unavailable now, such as a panorama holding navigation; null when it is available. */
  readonly pinningBlocked: string | null;
  /** True while a tracked point is the centre of every zoom and rotation. */
  readonly tracking: boolean;
  /** Each family's last acquisition per operation: what was asked for and what was used. */
  readonly last: { readonly [F in AnchorFamily]: { readonly [O in AnchorOperation]?: NavigationAnchor } };
}

/**
 * What a host's controls use: the pin, Pick point, and what the last
 * gestures used (`GlobeRuntime.navigationAnchors`). The pin is this
 * session's: never saved, exported or put in the URL.
 */
export interface GlobeNavigationAnchors {
  status(): NavigationAnchorStatus;
  subscribe(listener: () => void): () => void;
  /** Arms Pick point, or cancels it when armed. True when it is armed afterwards. */
  togglePick(): boolean;
  armPick(): boolean;
  cancelPick(): void;
  /** Pins the compass target as it is now. False when pinning is unavailable. */
  pinTarget(): boolean;
  clearPin(): void;
}
