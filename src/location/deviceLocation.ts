import type { GeodeticLocation } from "./contracts.js";

/** A reading from the device that is showing this page. */
export interface DeviceLocationFix {
  latDeg: number;
  lonDeg: number;
  /** Radius of the 1-sigma horizontal uncertainty, metres. */
  accuracyMeters: number;
  altMeters?: number;
}

export interface DeviceLocationPort {
  /** Start continuous readings. The returned function stops them; it is safe to call twice. */
  watch(onFix: (fix: DeviceLocationFix) => void, onError: (message: string) => void): () => void;
}

/** Structural view of `navigator.geolocation`, so a test can supply a fake. */
export interface DeviceGeolocation {
  watchPosition(
    success: (position: { coords: DeviceGeolocationCoords }) => void,
    error?: ((error: { code: number }) => void) | null,
    options?: PositionOptions,
  ): number;
  clearWatch(id: number): void;
}

export interface DeviceGeolocationCoords {
  latitude: number;
  longitude: number;
  accuracy: number;
  altitude?: number | null;
}

/** Farther than this, the first fix brings the view in so the accuracy circle can be seen. */
export const DEVICE_LOCATION_CLOSE_ZOOM_METERS = 8_000;
/** Camera distance used when the current view is too far to see a street-level fix. */
export const DEVICE_LOCATION_ARRIVAL_ZOOM_METERS = 1_500;

/** Blue used for the position dot and its accuracy disc. */
export const DEVICE_LOCATION_BLUE: [number, number, number] = [66, 133, 244];
export const DEVICE_LOCATION_DOT_STROKE: [number, number, number] = [255, 255, 255];
/** Position dot diameter in screen pixels. It stays this size as the camera moves. */
export const DEVICE_LOCATION_DOT_PX = 18;
export const DEVICE_LOCATION_ACCURACY_OPACITY = 0.25;
/** Metres the accuracy disc and the dot sit above the surface so they clear the ground. */
export const DEVICE_LOCATION_ACCURACY_LIFT_M = 2;
export const DEVICE_LOCATION_DOT_LIFT_M = 6;

const WATCH: PositionOptions = { enableHighAccuracy: true, maximumAge: 1_000, timeout: 20_000 };

export function deviceLocationErrorMessage(code: number): string {
  if (code === 1) return "Location permission was denied.";
  if (code === 2) return "Device location is unavailable.";
  if (code === 3) return "Device location timed out.";
  return "Device location failed.";
}

export function deviceLocationFixFromCoords(coords: DeviceGeolocationCoords): DeviceLocationFix | null {
  const latDeg = coords.latitude;
  const lonDeg = coords.longitude;
  const accuracyMeters = coords.accuracy;
  if (![latDeg, lonDeg, accuracyMeters].every(Number.isFinite)) return null;
  if (Math.abs(latDeg) > 90 || Math.abs(lonDeg) > 180 || accuracyMeters < 0) return null;
  const altitude = coords.altitude;
  return {
    latDeg, lonDeg, accuracyMeters,
    ...(typeof altitude === "number" && Number.isFinite(altitude) ? { altMeters: altitude } : {}),
  };
}

/** World diameter of the accuracy disc. The atlas disc is inset by a pixel, so the sprite is slightly larger than the range. */
export function accuracySpriteSize(accuracyMeters: number, cellSize: number, insetPx = 1): number {
  if (!(accuracyMeters > 0) || !(cellSize > insetPx * 2)) return 0;
  const drawn = cellSize - insetPx * 2;
  return accuracyMeters * 2 * cellSize / drawn;
}

/** World size of a sprite that should cover `sizePx` of a perspective view. */
export function screenConstantSpriteSize(distanceMeters: number, verticalFovRad: number, viewportHeightPx: number, sizePx: number): number {
  if (!(distanceMeters > 0) || !(verticalFovRad > 0) || !(viewportHeightPx > 0) || !(sizePx > 0)) return 0;
  return sizePx * (2 * distanceMeters * Math.tan(verticalFovRad / 2)) / viewportHeightPx;
}

export function formatDeviceAccuracy(accuracyMeters: number): string {
  if (!(accuracyMeters > 0)) return "";
  if (accuracyMeters >= 10_000) return `${Math.round(accuracyMeters / 1000)} km`;
  if (accuracyMeters >= 1_000) return `${(accuracyMeters / 1000).toFixed(1)} km`;
  return `${Math.round(accuracyMeters)} m`;
}

/** Where the first fix puts the view. A view already near the ground keeps its distance. */
export function deviceLocationView(fix: DeviceLocationFix, currentZoomMeters: number | undefined): GeodeticLocation {
  const close = currentZoomMeters !== undefined && currentZoomMeters <= DEVICE_LOCATION_CLOSE_ZOOM_METERS;
  return {
    latDeg: fix.latDeg, lonDeg: fix.lonDeg,
    ...(close ? {} : { zoomMeters: DEVICE_LOCATION_ARRIVAL_ZOOM_METERS }),
  };
}

export function browserDeviceLocation(geolocation: DeviceGeolocation | null | undefined): DeviceLocationPort {
  return {
    watch(onFix, onError) {
      if (!geolocation) {
        onError("Device location is unavailable.");
        return () => {};
      }
      let stopped = false;
      let id = 0;
      try {
        id = geolocation.watchPosition((position) => {
          if (stopped) return;
          const fix = deviceLocationFixFromCoords(position.coords);
          if (fix) onFix(fix);
        }, (error) => {
          if (!stopped) onError(deviceLocationErrorMessage(error.code));
        }, WATCH);
      } catch {
        onError("Device location is unavailable.");
        return () => {};
      }
      return () => {
        if (stopped) return;
        stopped = true;
        geolocation.clearWatch(id);
      };
    },
  };
}
