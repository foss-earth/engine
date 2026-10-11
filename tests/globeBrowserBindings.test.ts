import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createManagedImageryAtlasResources } from "../src/babylon/managedImageryAtlas.js";
import { createImageSessionBroker } from "@foss-earth/images";
it("uses the supplied image pool/generation for managed atlas reservations", () => {
  const broker = createImageSessionBroker({ requests: 1, decodes: 1, pools: { sourceGpu: 10, decoded: 10, encoded: 10, uploadOutstanding: 10, overlap: 10 } });
  const atlas = createManagedImageryAtlasResources(broker);
  const hold = atlas.reserveGpu(4, "one atlas", { overlap: false })!; expect(broker.pools.stats().sourceGpu.reserved).toBe(4);
  hold.release(); expect(broker.pools.live()).toEqual([]); broker.dispose();
});
describe("public browser binding authority and startup regression", () => {
  it("preserves the named mesh budget, reviewed dimensions, and actual async acquisition", () => {
    const source = readFileSync(new URL("../src/browser/globeBindings.ts", import.meta.url), "utf8");
    expect(source).toContain('map.terrain.meshRebuildTimePerFrame'); expect(source).toContain('createBoundedMapTextureLoader');
    expect(source).toContain('source.tileSize'); expect(source).not.toContain('bootstrapGlobeRenderer');
    expect(source).not.toContain('createRenderScheduler'); expect(source).not.toContain('createSkyRuntime');
  });
});
