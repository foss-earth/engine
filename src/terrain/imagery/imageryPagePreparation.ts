import { buildPageLevels, IMAGERY_PAGE_SIZE } from "./imageryAtlasLayout.js";

/**
 * Splits decoded RGBA pixels into atlas pages: one per 256-pixel square, row
 * by row, each with its gutters and levels. An image that is not a whole
 * number of pages yields none, and the residency rejects it by its size.
 */
export function preparePages(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): Uint8Array[][] {
  if (width % IMAGERY_PAGE_SIZE !== 0 || height % IMAGERY_PAGE_SIZE !== 0) return [];
  const pages: Uint8Array[][] = [];
  for (let y = 0; y < height; y += IMAGERY_PAGE_SIZE) {
    for (let x = 0; x < width; x += IMAGERY_PAGE_SIZE) pages.push(buildPageLevels(rgba, width, height, x, y));
  }
  return pages;
}

/**
 * Some servers answer a tile they have no data for with a fully transparent
 * image instead of a 404. That is a missing tile, not content to draw.
 */
export function isBlankImage(rgba: Uint8ClampedArray | Uint8Array): boolean {
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 0) return false;
  return true;
}

