import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { instantiateTerrainCore } from "../terrain-WASM/index.js";

// P-130. V8 calls an imported Math function from WebAssembly faster than a bound copy of it, and Math's functions
// ignore their receiver, so the terrain core is given the functions themselves.
describe("The terrain core's Math imports", () => {
  it("are the worker realm's Math functions themselves, not copies", async () => {
    const instantiate = vi.spyOn(WebAssembly, "instantiate");
    try {
      const core = await instantiateTerrainCore(readFileSync(new URL("../terrain-WASM/single/terrain.wasm", import.meta.url)), { workerRealm: true });
      core.dispose();
      const imports = (instantiate.mock.calls[0]?.[1] as { Math: Record<string, unknown> }).Math;
      expect(Object.keys(imports).length).toBeGreaterThan(0);
      for (const [name, value] of Object.entries(imports)) expect(value, name).toBe(Math[name as keyof Math]);
    } finally { instantiate.mockRestore(); }
  });

  // P-132. sqrt, floor, round, min and max are computed in WebAssembly, bit for bit as Math does, without a call out.
  it("are only the transcendental functions", () => {
    const module = new WebAssembly.Module(readFileSync(new URL("../terrain-WASM/single/terrain.wasm", import.meta.url)));
    expect(WebAssembly.Module.imports(module).map(entry => `${entry.module}.${entry.name}`).sort()).toEqual(["Math.atan", "Math.cos", "Math.pow", "Math.sin", "Math.sinh"]);
  });
});
