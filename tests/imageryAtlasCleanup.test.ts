import { NullEngine, Scene } from "@babylonjs/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createImageryAtlas } from "../src/babylon/imagery/imageryAtlas.js";
import { planAtlasLayout } from "../src/terrain/imagery/imageryAtlasLayout.js";
import { testAtlasDevice } from "../fixtures/composition/runtimeHost.js";
afterEach(() => vi.restoreAllMocks());
const layout = () => planAtlasLayout({ maxBytes: 16 * 2 ** 20, maxTextureSize: 8192, powerOfTwo: false, maxPatches: 1 })!;
describe("actual imagery atlas owned allocation", () => {
  it("releases the first actual texture when second allocation fails and preserves both errors", () => {
    const engine = new NullEngine(), scene = new Scene(engine), device = testAtlasDevice(scene);
    const allocation = new Error("table allocation failed"), cleanup = new Error("first texture cleanup failed");
    const original = device.createRawTexture; let first: ReturnType<typeof original> | undefined, release: ReturnType<typeof vi.spyOn> | undefined;
    device.createRawTexture = options => { if (first) throw allocation; first = original(options); release = vi.spyOn(first, "dispose").mockImplementationOnce(() => { throw cleanup; }); return first; };
    try {
      let failure: unknown; try { createImageryAtlas(scene, layout(), 1, device); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(AggregateError); expect((failure as AggregateError).errors).toEqual([allocation, cleanup]); expect(release).toHaveBeenCalledOnce();
    } finally { release?.mockRestore(); first?.dispose(); scene.dispose(); engine.dispose(); }
  });
  it("attempts table release after atlas release throws and never cleans either twice", () => {
    const engine = new NullEngine(), scene = new Scene(engine), atlas = createImageryAtlas(scene, layout(), 2, testAtlasDevice(scene));
    const error = new Error("atlas disposal failed"), texture = vi.spyOn(atlas.texture, "dispose").mockImplementationOnce(() => { throw error; }), table = vi.spyOn(atlas.table, "dispose");
    try { expect(() => atlas.dispose()).toThrow(error); expect(table).toHaveBeenCalledOnce(); atlas.dispose(); expect(texture).toHaveBeenCalledOnce(); expect(table).toHaveBeenCalledOnce(); }
    finally { texture.mockRestore(); atlas.texture.dispose(); scene.dispose(); engine.dispose(); }
  });
});
