import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
// Functional parity is mandatory before preparing performance adapters.
await import("./check-parity.mjs");
const directory = new URL("../../build/raster-WASM/ab/", import.meta.url);
mkdirSync(directory, { recursive: true });
for (const [file, backend] of [["typescript.mjs", "typescript"], ["wasm.mjs", "single"]]) {
  writeFileSync(new URL(file, directory), `import { createMeasurement } from '../../../raster-WASM/scripts/worker-measurement.mjs';\nexport const receipts = { backend: ${JSON.stringify(backend)}, preparedAt: new Date().toISOString() };\nexport const measure = await createMeasurement(${JSON.stringify(backend)});\nexport const dispose = () => measure.dispose();\n`);
}
console.log("Prepared actual TypeScript and Rust/WASM worker adapters under " + fileURLToPath(directory));
console.log("From the research checkout: node scripts/benchmarks/earth-compare/shared.mjs --a=../engine/build/raster-WASM/ab/typescript.mjs --b=../engine/build/raster-WASM/ab/wasm.mjs --pairs=12 --seed=1 --maximum-seconds=600");
