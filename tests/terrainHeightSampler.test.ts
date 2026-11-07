import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { instantiateTerrainCore } from "../terrain-WASM/index.js";

const REFUSAL = "Height batches need 1–65536 finite x/y pairs";

function thrownBy(work: () => unknown): unknown {
  try { work(); } catch (error) { return error; }
  return undefined;
}

// P-133. The core refuses a batch with a point that is not finite, so the sampler looks for one only when a batch
// fails. Such a batch is refused as when the sampler checked first, and what the refusal took is released.
describe("The terrain core's height sampler", () => {
  it("refuses a batch with a point that is not finite, wherever it is, and releases what each refusal took", async () => {
    const core = await instantiateTerrainCore(readFileSync(new URL("../terrain-WASM/single/terrain.wasm", import.meta.url)), { workerRealm: true });
    const size = 33;
    const sampler = core.createHeightSampler({ z: 4, x: 5, y: 7, size, heights: Float32Array.from({ length: size * size }, (_, i) => (i % 17) - 3.5) });
    try {
      const finite = Float64Array.from({ length: 131072 }, (_, i) => (i % 2 ? 7 : 5) + ((i * 7919) % 1000) / 1000);
      const want = sampler.sample(finite);
      for (const value of [NaN, Infinity, -Infinity]) for (const at of [0, 1, 65535, 131070, 131071]) {
        const batch = finite.slice();
        batch[at] = value;
        const error = thrownBy(() => sampler.sample(batch));
        expect(error, `${value} at ${at}`).toBeInstanceOf(RangeError);
        expect((error as Error).message).toBe(REFUSAL);
      }
      // Each refusal takes 1.5 MiB of the core's memory while it runs: kept, these would use it up.
      const bad = finite.slice();
      bad[131071] = NaN;
      for (let i = 0; i < 300; i++) expect(thrownBy(() => sampler.sample(bad))).toBeInstanceOf(RangeError);
      expect(Buffer.from(sampler.sample(finite).buffer).equals(Buffer.from(want.buffer))).toBe(true);
    } finally { sampler.dispose(); core.dispose(); }
  });
});
