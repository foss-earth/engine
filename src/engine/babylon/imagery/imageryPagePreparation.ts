import { buildPageLevels, IMAGERY_PAGE_SIZE } from "./imageryAtlasLayout";

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

/** Decodes an image blob to RGBA with the browser's decoder, off the DOM. */
export async function decodeImageBlob(blob: Blob): Promise<{ width: number; height: number; data: Uint8ClampedArray }> {
  const bitmap = await createImageBitmap(blob, { premultiplyAlpha: "none", colorSpaceConversion: "default" });
  try {
    const { width, height } = bitmap;
    const canvas: OffscreenCanvas | HTMLCanvasElement = typeof OffscreenCanvas !== "undefined"
      ? new OffscreenCanvas(width, height)
      : Object.assign(document.createElement("canvas"), { width, height });
    const context = canvas.getContext("2d", { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
    if (!context) throw new Error("A 2D canvas is not available to decode map imagery.");
    context.drawImage(bitmap, 0, 0);
    return { width, height, data: context.getImageData(0, 0, width, height).data };
  } finally {
    bitmap.close();
  }
}
