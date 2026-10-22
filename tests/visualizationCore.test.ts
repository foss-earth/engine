import { describe, expect, it } from "vitest";
import { DEFAULT_POI_REFINEMENT_POLICY, poiRefinementLod, poiRefinementTileRadius, spriteSizeForDistance, buildPoiTileIndex, makeTileKey,
  compassRadiusMeters, compassLineFade, compassLabelMeters, horizonCompassPlacements, DEFAULT_POI_SPRITE_SIZE_PARAMS, DEFAULT_ORBIT_COMPASS_SCALE_PARAMS, VISUALIZATION_MIGRATIONS } from "../src/index.js";
import { ENGINE_VISUALIZATION_PARAMETERS, ENGINE_POINT_RESOURCE_PARAMETERS } from "../src/settings/index.js";

describe("pure point and compass policies", () => {
  it("preserves every source refinement boundary and explicitly accepts host policy", () => {
    expect([5_000,20_000,60_000,120_000,120_001].map(value=>poiRefinementLod(value))).toEqual([17,16,15,14,null]);
    expect([10_000,45_000,45_001].map(value=>poiRefinementTileRadius(value))).toEqual([1,2,3]);
    const policy={...DEFAULT_POI_REFINEMENT_POLICY,maxZoomMeters:500,lodLevels:[9,8,7,6] as const,tileRadii:[4,5,6] as const};
    expect(poiRefinementLod(100,policy)).toBe(9); expect(poiRefinementLod(501,policy)).toBeNull();expect(poiRefinementTileRadius(100,policy)).toBe(4);
  });
  it("retains distance-based size and wrapped geographic tile indexing", () => {
    expect(spriteSizeForDistance(100,40_000,200,100,1_000_000)).toBe(200);
    expect(spriteSizeForDistance(1_000_000,40_000,200,100,1_000_000)).toBe(40_000);
    expect(spriteSizeForDistance(500,50,10,0,1000)).toBe(30);
    expect(makeTileKey(2,-1,2)).toBe("2/3/2");expect(makeTileKey(2,0,-1)).toBeNull();
    const point={lat:0,lng:0};expect([...buildPoiTileIndex([point,point],2).values()]).toEqual([[point,point]]);
  });
  it("preserves old values, homes and legacy migrations without a browser store", () => {
    expect(DEFAULT_POI_SPRITE_SIZE_PARAMS).toEqual({maxSize:40_000,minSize:200,minRefZoom:100,maxRefZoom:1_000_000});
    expect(DEFAULT_ORBIT_COMPASS_SCALE_PARAMS).toEqual({radiusScale:.035,minRadius:8_000,maxRadius:240_000,minDistance:8_000/.035,maxDistance:240_000/.035,labelSizeScale:.16});
    expect(compassRadiusMeters(1_000, DEFAULT_ORBIT_COMPASS_SCALE_PARAMS).radius).toBe(8_000);
    expect(compassRadiusMeters(100_000, DEFAULT_ORBIT_COMPASS_SCALE_PARAMS).radius).toBe(8_000);
    const { minDistance, maxDistance, minRadius, maxRadius } = DEFAULT_ORBIT_COMPASS_SCALE_PARAMS;
    expect(compassRadiusMeters(minDistance!, DEFAULT_ORBIT_COMPASS_SCALE_PARAMS).radius).toBeCloseTo(minRadius, 3);
    expect(compassRadiusMeters(maxDistance!, DEFAULT_ORBIT_COMPASS_SCALE_PARAMS).radius).toBeCloseTo(maxRadius, 3);
    expect(compassRadiusMeters((minDistance! + maxDistance!) / 2, DEFAULT_ORBIT_COMPASS_SCALE_PARAMS).radius).toBeCloseTo((minRadius + maxRadius) / 2, 0);
    expect(compassLineFade(1_000, DEFAULT_ORBIT_COMPASS_SCALE_PARAMS)).toBe(0);
    expect(compassLineFade(minDistance!, DEFAULT_ORBIT_COMPASS_SCALE_PARAMS)).toBe(1);
    expect(compassLabelMeters(200_000, DEFAULT_ORBIT_COMPASS_SCALE_PARAMS)).toBeCloseTo(compassLabelMeters(100_000, DEFAULT_ORBIT_COMPASS_SCALE_PARAMS) * 2, 3);
    const radius = 6_378_137;
    const camera = { x: radius + 500_000, y: 0, z: 0 };
    const placements = horizonCompassPlacements(camera, { radiusMeters: radius })!;
    const letter = (id: "N" | "E" | "S" | "W") => placements.find(item => item.id === id)!;
    const north = letter("N");
    const distance = Math.hypot(camera.x, camera.y, camera.z);
    const slant = Math.sqrt(distance * distance - radius * radius);
    const tangent = { x: radius * radius / distance, y: 0, z: radius * slant / distance };
    const toward = (point: { x: number; y: number; z: number }) => {
      const dx = point.x - camera.x, dy = point.y - camera.y, dz = point.z - camera.z;
      return dx / Math.hypot(dx, dy, dz);
    };
    expect(toward(north.position)).toBeGreaterThan(toward(tangent));
    expect(north.position.z).toBeGreaterThan(100_000);
    expect(letter("E").position.y).toBeGreaterThan(100_000);
    expect(letter("S").position.z).toBeLessThan(-100_000);
    expect(letter("W").position.y).toBeLessThan(-100_000);
    for (const item of placements) expect(Math.hypot(item.position.x, item.position.y, item.position.z)).toBeGreaterThan(radius + 1_000);
    const clipped = horizonCompassPlacements(camera, { radiusMeters: radius, maxDistanceMeters: 200_000 })!;
    for (const [index, item] of clipped.entries()) {
      const full = placements[index];
      expect(Math.hypot(item.position.x - camera.x, item.position.y, item.position.z)).toBeLessThan(250_000);
      // Moving nearer preserves both the apparent size and the bearing.
      expect((item.position.x - camera.x) / item.sizeMeters).toBeCloseTo((full.position.x - camera.x) / full.sizeMeters, 10);
      expect(item.position.y / item.sizeMeters).toBeCloseTo(full.position.y / full.sizeMeters, 10);
      expect(item.position.z / item.sizeMeters).toBeCloseTo(full.position.z / full.sizeMeters, 10);
    }
    expect(horizonCompassPlacements({ x: radius + 2_000_000, y: 0, z: 0 })![0].sizeMeters).toBeGreaterThan(horizonCompassPlacements({ x: radius + 20_000, y: 0, z: 0 })![0].sizeMeters * 5);
    const pole = horizonCompassPlacements({ x: 0, y: 0, z: radius + 500_000 })!;
    expect(pole).toHaveLength(4);
    expect(pole.every(item => Math.hypot(item.position.x, item.position.y) > 100_000)).toBe(true);
    const height=ENGINE_VISUALIZATION_PARAMETERS.find(spec=>spec.id==="visualization.compass.heightOffset")!;
    expect(height.home).toEqual({tab:"controls",section:"camera",level:"main"});
    const compassSection = new Set(["visualization.compass.mode", "visualization.compass.radius", "visualization.compass.distance", "visualization.compass.labelSizeScale"]);
    expect(ENGINE_VISUALIZATION_PARAMETERS.filter(spec=>spec.id!==height.id && !compassSection.has(spec.id)).every(spec=>spec.home.tab==="renderer"&&spec.home.section==="performance")).toBe(true);
    expect([...compassSection].every(id => {
      const home = ENGINE_VISUALIZATION_PARAMETERS.find(spec => spec.id === id)?.home;
      return home?.tab === "interface" && home.section === "compass" && home.level === "main";
    })).toBe(true);
    expect(ENGINE_VISUALIZATION_PARAMETERS.find(spec => spec.id === "visualization.compass.mode")).toMatchObject({ default: "horizon", choiceControl: "two-position" });
    expect(ENGINE_POINT_RESOURCE_PARAMETERS.find(spec=>spec.id==="visualization.poiSprite.minCapacity")?.default).toBe(32_000);
    expect(VISUALIZATION_MIGRATIONS.find(m=>m.key==="foss-earth.compassHeightOffsetMeters")!.migrate("5000")).toEqual({"visualization.compass.heightOffset":1000});
    expect(VISUALIZATION_MIGRATIONS.find(m=>m.key==="foss-earth.compass-scale-defaults")!.migrate(JSON.stringify({radiusScale:.05,minRadius:750,maxRadius:240000,labelSizeScale:.2}))).toEqual({"visualization.compass.radius":{min:750,max:240000},"visualization.compass.distance":{min:15_000,max:4_800_000},"visualization.compass.labelSizeScale":.2});
    expect(VISUALIZATION_MIGRATIONS.find(m=>m.key==="foss-earth.poiSpriteTunerVisible")!.migrate("false")).toEqual({"interface.poiSpriteTuner":false});
  });
});
