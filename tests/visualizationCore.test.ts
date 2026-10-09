import { describe, expect, it } from "vitest";
import { DEFAULT_POI_REFINEMENT_POLICY, poiRefinementLod, poiRefinementTileRadius, spriteSizeForDistance, buildPoiTileIndex, makeTileKey,
  DEFAULT_POI_SPRITE_SIZE_PARAMS, DEFAULT_ORBIT_COMPASS_SCALE_PARAMS, VISUALIZATION_MIGRATIONS } from "../src/index.js";
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
    expect(DEFAULT_ORBIT_COMPASS_SCALE_PARAMS).toEqual({radiusScale:.035,minRadius:750,maxRadius:240_000,labelSizeScale:.16});
    const height=ENGINE_VISUALIZATION_PARAMETERS.find(spec=>spec.id==="visualization.compass.heightOffset")!;
    expect(height.home).toEqual({tab:"controls",section:"camera",level:"main"});
    expect(ENGINE_VISUALIZATION_PARAMETERS.filter(spec=>spec.id!==height.id).every(spec=>spec.home.tab==="renderer"&&spec.home.section==="performance")).toBe(true);
    expect(ENGINE_POINT_RESOURCE_PARAMETERS.find(spec=>spec.id==="visualization.poiSprite.minCapacity")?.default).toBe(32_000);
    expect(VISUALIZATION_MIGRATIONS.find(m=>m.key==="foss-earth.compassHeightOffsetMeters")!.migrate("5000")).toEqual({"visualization.compass.heightOffset":1000});
    expect(VISUALIZATION_MIGRATIONS.find(m=>m.key==="foss-earth.compass-scale-defaults")!.migrate(JSON.stringify({radiusScale:.05,minRadius:750,maxRadius:240000,labelSizeScale:.2}))).toEqual({"visualization.compass.radiusScale":.05,"visualization.compass.minRadius":750,"visualization.compass.maxRadius":240000,"visualization.compass.labelSizeScale":.2});
    expect(VISUALIZATION_MIGRATIONS.find(m=>m.key==="foss-earth.poiSpriteTunerVisible")!.migrate("false")).toEqual({"interface.poiSpriteTuner":false});
  });
});
