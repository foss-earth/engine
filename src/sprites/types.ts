export type RgbColor = [number, number, number];

export interface MarkerStyle {
  fill: RgbColor;
  stroke: RgbColor;
  /** Pixel width of the ring. `0` fills the cell with a disc and draws no ring. */
  strokeWidth?: number;
}

export const DEFAULT_DOT_TEXTURE_SIZE = 64;
export const DEFAULT_SPRITE_CAPACITY = 32_000;
export const EARTH_RADIUS_METERS = 6_371_000;

export function rgbToCss(rgb: RgbColor): string {
  return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
}

export function markerStyleKey(style: MarkerStyle): string {
  const key = `${style.fill.join('-')}_${style.stroke.join('-')}`;
  return style.strokeWidth === undefined ? key : `${key}_${style.strokeWidth}`;
}
