import type { AbstractMesh, Scene, Sprite } from "@babylonjs/core";

/**
 * What the ground and its tiles record on a mesh. A point of interest has
 * something else: the displayed surface is not one, so a drag can grab it.
 */
const GROUND_METADATA_KEYS = new Set(["mapSurface", "terrainZoom", "segments", "heightBounds", "googleGeometricErrorMeters"]);

function isWorldPointMetadata(metadata: unknown): boolean {
  if (metadata == null || typeof metadata !== "object") return false;
  return Object.keys(metadata).some(key => !GROUND_METADATA_KEYS.has(key));
}

export interface PickPointMetadataOptions {
  /** Optional predicate to filter sprites considered for picking. */
  spritePredicate?: (sprite: Sprite) => boolean;
  /** Optional predicate to filter meshes considered for picking. */
  meshPredicate?: (mesh: AbstractMesh) => boolean;
  /** Skip the close-up mesh fallback when only sprite picking is desired. */
  meshFallback?: boolean;
}

/**
 * Pick a point under `(x, y)` by:
 *   1. Trying sprite picking first (common case — sprites are the primary POI
 *      visualization at distance).
 *   2. Falling back to mesh picking when no sprite is hit and `meshFallback`
 *      is enabled (default true) — useful when sprites are replaced by
 *      close-up sphere LOD geometry.
 *
 * Returns the metadata attached to the picked sprite or mesh, cast to `T`, or
 * null when nothing is hit.
 */
export function pickPointMetadata<T = unknown>(
  scene: Scene,
  x: number,
  y: number,
  options: PickPointMetadataOptions = {},
): T | null {
  const spritePredicate = options.spritePredicate ?? ((s: Sprite) => s.isPickable);
  const sr = scene.pickSprite(x, y, spritePredicate);
  if (sr?.hit && sr.pickedSprite) {
    const meta = (sr.pickedSprite as unknown as { metadata?: unknown }).metadata;
    if (meta !== undefined && meta !== null) return meta as T;
  }
  if (options.meshFallback === false) return null;

  const meshPredicate = options.meshPredicate
    ?? ((m: AbstractMesh) => isWorldPointMetadata(m.metadata));
  const mr = scene.pick(x, y, meshPredicate);
  if (mr?.hit && mr.pickedMesh?.metadata !== undefined && mr.pickedMesh?.metadata !== null) {
    return mr.pickedMesh.metadata as T;
  }
  return null;
}

/** True when a point of interest sits under the viewport point. The ground's own metadata is not one. */
export function hasPickablePointAt(
  scene: Scene,
  x: number,
  y: number,
  options: PickPointMetadataOptions = {},
): boolean {
  return pickPointMetadata(scene, x, y, options) !== null;
}
