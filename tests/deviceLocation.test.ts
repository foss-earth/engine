import { describe, expect, it, vi } from "vitest";
import {
  accuracySpriteSize, browserDeviceLocation, deviceLocationErrorMessage, deviceLocationFixFromCoords,
  deviceLocationView, DEVICE_LOCATION_ARRIVAL_ZOOM_METERS, formatDeviceAccuracy, screenConstantSpriteSize,
  type DeviceGeolocation,
} from "../src/location/deviceLocation.js";

describe("device location readings", () => {
  it("keeps a finite fix and its altitude, and drops a reading off the earth", () => {
    expect(deviceLocationFixFromCoords({ latitude: 44.97, longitude: -93.23, accuracy: 12, altitude: 260 })).toEqual({
      latDeg: 44.97, lonDeg: -93.23, accuracyMeters: 12, altMeters: 260,
    });
    expect(deviceLocationFixFromCoords({ latitude: 1, longitude: 2, accuracy: 3, altitude: null })).toEqual({ latDeg: 1, lonDeg: 2, accuracyMeters: 3 });
    expect(deviceLocationFixFromCoords({ latitude: 91, longitude: 0, accuracy: 1 })).toBeNull();
    expect(deviceLocationFixFromCoords({ latitude: 0, longitude: 181, accuracy: 1 })).toBeNull();
    expect(deviceLocationFixFromCoords({ latitude: 0, longitude: 0, accuracy: -1 })).toBeNull();
    expect(deviceLocationFixFromCoords({ latitude: Number.NaN, longitude: 0, accuracy: 1 })).toBeNull();
  });

  it("names the geolocation error and formats the range", () => {
    expect(deviceLocationErrorMessage(1)).toBe("Location permission was denied.");
    expect(deviceLocationErrorMessage(2)).toBe("Device location is unavailable.");
    expect(deviceLocationErrorMessage(3)).toBe("Device location timed out.");
    expect(deviceLocationErrorMessage(0)).toBe("Device location failed.");
    expect(formatDeviceAccuracy(0)).toBe("");
    expect(formatDeviceAccuracy(12.4)).toBe("12 m");
    expect(formatDeviceAccuracy(1500)).toBe("1.5 km");
    expect(formatDeviceAccuracy(20_000)).toBe("20 km");
  });

  it("sizes the accuracy disc in metres and the dot in screen pixels", () => {
    expect(accuracySpriteSize(0, 64)).toBe(0);
    expect(accuracySpriteSize(10, 64)).toBeCloseTo(20 * 64 / 62);
    expect(screenConstantSpriteSize(0, 1, 100, 18)).toBe(0);
    expect(screenConstantSpriteSize(1000, Math.PI / 2, 200, 18)).toBeCloseTo(180);
  });

  it("brings a far view in and leaves a close view where it is", () => {
    const fix = { latDeg: 45, lonDeg: -93, accuracyMeters: 8 };
    expect(deviceLocationView(fix, undefined)).toEqual({ latDeg: 45, lonDeg: -93, zoomMeters: DEVICE_LOCATION_ARRIVAL_ZOOM_METERS });
    expect(deviceLocationView(fix, 20_000)).toEqual({ latDeg: 45, lonDeg: -93, zoomMeters: DEVICE_LOCATION_ARRIVAL_ZOOM_METERS });
    expect(deviceLocationView(fix, 400)).toEqual({ latDeg: 45, lonDeg: -93 });
  });

  it("watches the supplied geolocation and stops", () => {
    const handlers: {
      success: ((position: { coords: { latitude: number; longitude: number; accuracy: number } }) => void) | null;
      failure: ((error: { code: number }) => void) | null;
    } = { success: null, failure: null };
    const clearWatch = vi.fn();
    const geolocation: DeviceGeolocation = {
      watchPosition(onFix, onError, options) {
        handlers.success = onFix;
        handlers.failure = onError ?? null;
        expect(options).toMatchObject({ enableHighAccuracy: true });
        return 4;
      },
      clearWatch,
    };
    const onFix = vi.fn();
    const onError = vi.fn();
    const stop = browserDeviceLocation(geolocation).watch(onFix, onError);
    handlers.success?.({ coords: { latitude: 10, longitude: 20, accuracy: 5 } });
    handlers.success?.({ coords: { latitude: 99, longitude: 0, accuracy: 5 } });
    expect(onFix).toHaveBeenCalledExactlyOnceWith({ latDeg: 10, lonDeg: 20, accuracyMeters: 5 });
    expect(onError).not.toHaveBeenCalled();
    handlers.failure?.({ code: 1 });
    expect(onError).toHaveBeenCalledExactlyOnceWith("Location permission was denied.");
    stop();
    stop();
    expect(clearWatch).toHaveBeenCalledExactlyOnceWith(4);
    handlers.success?.({ coords: { latitude: 1, longitude: 2, accuracy: 3 } });
    expect(onFix).toHaveBeenCalledOnce();
  });

  it("reports a missing geolocation without watching", () => {
    const onError = vi.fn();
    const stop = browserDeviceLocation(null).watch(vi.fn(), onError);
    expect(onError).toHaveBeenCalledExactlyOnceWith("Device location is unavailable.");
    stop();
  });
});
