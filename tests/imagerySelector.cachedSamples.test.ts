import { expect, it } from "vitest";
import { measureImageryView, type ImagerySurface } from "../src/terrain/imagery/imagerySelector.js";
import { createTestView } from "../src/terrain/imagery/imageryTestViews.js";

it("keeps ready samples through nested surface queries but rebuilds unknown samples for new bounds without a revision", () => {
  const view = createTestView({ latDeg: 44.97, lonDeg: -93.23, altitudeMeters: 3000, pitchDeg: 70, headingDeg: 30 });
  const source = { id: "s", version: "1", kind: "photographic" as const, minLevel: 0, maxLevel: 19, tileWidth: 256, tileHeight: 256, variants: [] };
  const tiles = [{ z: 10, x: 246, y: 368 }, { z: 10, x: 247, y: 368 }];
  let high = 0, nested = false, callbacks = 0;
  const scalar: ImagerySurface = { heightAt: () => null, boundsFor: () => ({ min: -100, max: high }) };
  const measured = (surface: ImagerySurface, chosen = tiles) => measureImageryView({ view, source, surface }, chosen);
  const surface: ImagerySurface = {
    ...scalar, getRevision: () => 7,
    heightsAt: coordinates => {
      callbacks++;
      if (!nested) {
        nested = true;
        expect(measured(surface, [tiles[1]])).toEqual(measured(scalar, [tiles[1]]));
      }
      return new Float64Array(coordinates.length / 2).fill(NaN);
    },
  };
  let changed = false;
  const first = measured(surface);
  expect(first).toEqual(measured(scalar));
  expect(measured(surface)).toEqual(first);
  expect(measured(surface)).toEqual(first);
  for (const bound of [500, 0, 1000, 0]) {
    high = bound;
    const current = measured(surface);
    expect(current).toEqual(measured(scalar));
    changed ||= current.some((item, i) => !Object.is(item.footprintPx, first[i].footprintPx) || !Object.is(item.screenArea, first[i].screenArea));
  }
  expect(callbacks).toBeGreaterThan(0);
  expect(changed).toBe(true);
});
