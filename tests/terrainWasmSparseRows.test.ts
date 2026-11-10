import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { instantiateTerrainCore } from "../terrain-WASM/index.js";
import { sampleTerrainHeightPixels } from "../src/browser/terrainHeightPixels.js";

// Frozen with P-159's binary, before neighbouring sparse keys shared a search.
const SHIPPED_DIGEST = "3582fa71ea60091cfa797fdbab33d374db9002430567268a31e58ba6e9696d1d";

it("keeps sparse bilinear rows exact, including clamped repeats, missing zero-weight pixels and NaN payloads", async () => {
  const core = await instantiateTerrainCore(readFileSync(new URL("../terrain-WASM/single/terrain.wasm", import.meta.url)), { workerRealm: true });
  const digest = createHash("sha256");
  let accepted = 0, refused = 0;
  try {
    for (const size of [1, 2, 3, 17, 256, 4096]) {
      const first = Math.max(0, size - 2), last = size - 1;
      const keys = [...new Set([first * size + first, first * size + last, last * size + first, last * size + last])];
      for (const bits of [0x42c80000, 0x80000000, 0x7fc12345, 0xffc00001, 0x7f800001, 0x00000001, 0xff800000]) {
        for (let subset = 1; subset < 1 << keys.length; subset++) {
          const indices = Uint32Array.from(keys.filter((_, i) => subset & 1 << i));
          const heights = new Float32Array(indices.length), words = new Uint32Array(heights.buffer);
          for (let i = 0; i < words.length; i++) words[i] = i % 2 ? 0x43480000 : bits;
          const source = { z: 0, x: 0, y: 0, size, indices, heights };
          const sampler = core.createHeightSampler(source);
          try {
            const middle = (size - 1) / size;
            // Include exact pixel centres, where missing neighbours still
            // invalidate the batch even when their interpolation weight is 0.
            for (const [x, y] of [[middle, middle], [1, 1], [1, middle], [middle, 1], [0, 0], [0.5 / size, 0.5 / size], [0.5, 0.5], [-1, -1]]) {
              digest.update(JSON.stringify([size, bits, subset, x, y]));
              let reference: number | undefined, referenceError: unknown;
              try { reference = sampleTerrainHeightPixels(source, x, y); }
              catch (error) { referenceError = error; }
              try {
                const result = sampler.sample(new Float64Array([x, y]));
                expect(referenceError).toBeUndefined();
                expect(Object.is(result[0], reference)).toBe(true);
                accepted++;
                digest.update("accepted"); digest.update(new Uint8Array(result.buffer));
                // Repeated calls cannot reuse another pixel or row's value.
                expect(new Uint8Array(sampler.sample(new Float64Array([x, y])).buffer)).toEqual(new Uint8Array(result.buffer));
              } catch (error) {
                if (!(error instanceof Error) || error.message !== "WASM height batch failed (4)") throw error;
                expect(referenceError).toBeInstanceOf(Error);
                expect((referenceError as Error).message).toBe("Sparse height snapshot is missing a required pixel");
                refused++;
                digest.update(error.message);
              }
            }
          } finally { sampler.dispose(); }
        }
      }
    }
    expect(accepted).toBeGreaterThan(100);
    expect(refused).toBeGreaterThan(100);
    expect(digest.digest("hex")).toBe(SHIPPED_DIGEST);
  } finally { core.dispose(); }
});
