export interface PoiSpriteSizeParams {
  maxSize: number;
  minSize: number;
  minRefZoom: number;
  maxRefZoom: number;
}

export const DEFAULT_POI_SPRITE_SIZE_PARAMS: PoiSpriteSizeParams = {
  maxSize: 40_000,
  minSize: 200,
  minRefZoom: 100,
  maxRefZoom: 1_000_000,
};


export interface OrbitCompassScaleParams {
  radiusScale: number;
  minRadius: number;
  maxRadius: number;
  labelSizeScale: number;
}

export const DEFAULT_ORBIT_COMPASS_SCALE_PARAMS: OrbitCompassScaleParams = {
  radiusScale: 0.035,
  minRadius: 750,
  maxRadius: 240_000,
  labelSizeScale: 0.16,
};


export const DEFAULT_COMPASS_LABEL_TEXTURE_SIZE = 128;
