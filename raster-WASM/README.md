# raster-WASM

The Rust twin of [raster-TS](../raster-TS/terrarium.ts): Terrarium RGBA tiles
to Float32 heights. The app's terrain decode workers can select it
(`wasm.core.raster`). It is single-threaded only.

```js
// In a worker. Nothing is fetched or compiled until the first call.
import { loadRasterCore } from "@foss-earth/engine/raster-WASM";
const core = await loadRasterCore();
const heights = core.decodeTerrarium(rgba, size); // an owned copy
```

`instantiateRasterCore(bytes)` takes the binary directly, for offline callers
and equivalent-output A/B tests. The ABI uses explicit owned buffers without
wasm-bindgen. All lengths and allocation ownership are validated, output is
copied before freeing, and the wrapper refreshes views after memory growth.
Input and returned output remain owned by the caller. Alpha holes and malformed
tiles keep the TypeScript decoder's errors. A missing binary or a different ABI
fails visibly; the wrapper never returns a JavaScript backend in its place, so
requested WASM reports an unavailable or fallback state rather than a
successful conversion.

## Build and checks

From the engine root:

```sh
node raster-WASM/scripts/build.mjs   # offline; writes single/raster.wasm and build-metadata.json
node raster-WASM/scripts/check.mjs   # source and binary receipts, size and Node validation
npm run check:parity                 # builds engine, then every parity check
npm run test:wasm                    # wrapper ABI and benchmark adapter tests
npm run test:rust                    # cargo tests of the three crates
npm run prepare:raster-ab
```

The build uses installed tools only and fails clearly if
`wasm32-unknown-unknown` is absent. It compiles the crate with bounded,
single-threaded memory (256 MiB) and SIMD, optimises it with the Binaryen
version pinned in `toolchain.lock.json`, and writes the actual binary with its
receipt. It never manufactures a placeholder binary. A successful build
establishes compilability, not correctness or performance.

`scripts/check-parity.mjs` compares the binary with the built raster-TS across
all 16,777,216 RGB colours, unaligned views, source size boundaries and alpha
failures, and writes `build/raster-WASM/raster-parity.json`. It fails when the
binary is missing; it never substitutes mock WASM or counts skipped tests as
parity proof.

`prepare:raster-ab` runs that correctness gate, then writes two measurement
adapters under `build/raster-WASM/ab/` and prints the research shared-machine
runner command. They run actual Node workers with TypeScript or Rust/WASM,
fixed inputs, identical iteration counts, startup and warmup excluded, and
actual-output hashes. The adapter uses a hot batch of 64 decodes with one input
clone and one final output transfer, so it measures amortised batch throughput
rather than per-tile production latency. The reported value includes dispatch,
that input clone, the kernels and their copies, and the final output transfer;
the kernel and copy interval is recorded separately. It does not measure
browser PNG/WebP readback, map rendering or watts. A/A controls and paired
uncertainty decide whether the relative performance evidence is conclusive.
