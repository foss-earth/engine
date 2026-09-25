import type { TileId } from "./imageryGeometry";
import type { ImagerySourceCapabilities, ImagerySourceKind } from "./imagerySelector";

/** The parts of a raster basemap descriptor imagery selection reads. */
export interface ImageryDescriptor {
  id: string;
  urlTemplate: string;
  kind?: ImagerySourceKind;
  version?: string;
  tileSize?: { width: number; height: number };
  variants?: readonly { id: string; width: number; height: number; urlTemplate: string; preservesContent: true }[];
  requestPolicy?: { maxConcurrent?: number; prefetch: boolean };
  minZoom?: number;
  maxZoom?: number;
  bounds?: { west: number; south: number; east: number; north: number };
}

const PAGE = 256;

function isPageMultiple(width: number, height: number): boolean {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width !== height) return false;
  const pages = width / PAGE;
  return pages >= 1 && Number.isInteger(pages) && (pages & (pages - 1)) === 0 && pages <= 2;
}

export interface ImagerySourceSupport {
  capabilities: ImagerySourceCapabilities | null;
  /** Descriptor entries left out, and why. */
  problems: string[];
}

/**
 * Selector capabilities from a reviewed descriptor. Standard tiles and
 * variants must be square 256- or 512-pixel images; anything else is left
 * out and reported rather than guessed at. The descriptor's maxZoom is the
 * approved request ceiling and is never raised.
 */
export function imagerySourceSupport(descriptor: ImageryDescriptor): ImagerySourceSupport {
  const problems: string[] = [];
  const tile = descriptor.tileSize ?? { width: PAGE, height: PAGE };
  if (!isPageMultiple(tile.width, tile.height)) {
    return { capabilities: null, problems: [`${descriptor.id}: ${tile.width}×${tile.height} tiles are not supported.`] };
  }
  const variants = (descriptor.variants ?? []).filter(variant => {
    const ok = variant.preservesContent === true
      && isPageMultiple(variant.width, variant.height)
      && variant.width > tile.width
      && variant.width % tile.width === 0;
    if (!ok) problems.push(`${descriptor.id}: variant ${variant.id} (${variant.width}×${variant.height}) is not a same-extent denser tile.`);
    return ok;
  }).map(variant => ({ id: variant.id, width: variant.width, height: variant.height }))
    .sort((a, b) => a.width * a.height - b.width * b.height);
  return {
    capabilities: {
      id: descriptor.id,
      version: descriptor.version ?? "1",
      kind: descriptor.kind ?? "cartographic",
      minLevel: descriptor.minZoom ?? 0,
      maxLevel: descriptor.maxZoom ?? 18,
      tileWidth: tile.width,
      tileHeight: tile.height,
      variants,
      coverage: descriptor.bounds,
    },
    problems,
  };
}

/** The URL of a tile, standard or of a reviewed variant. Fractional zooms never reach a URL. */
export function imageryTileUrl(descriptor: ImageryDescriptor, tile: TileId, variant: string | null): string {
  const template = variant === null
    ? descriptor.urlTemplate
    : descriptor.variants?.find(candidate => candidate.id === variant)?.urlTemplate;
  if (!template) throw new Error(`${descriptor.id} has no reviewed "${variant}" variant.`);
  if (!Number.isInteger(tile.z) || !Number.isInteger(tile.x) || !Number.isInteger(tile.y)) throw new Error("Tile coordinates must be whole numbers.");
  return template.replace(/\{z\}/g, String(tile.z)).replace(/\{x\}/g, String(tile.x)).replace(/\{y\}/g, String(tile.y));
}
