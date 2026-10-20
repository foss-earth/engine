# terrain-WASM

The Rust twin of [terrain-TS](../terrain-TS/terrainNumericGeometry.ts): the
numeric surface that `src/babylon/terrainMesh.ts` builds, using the
interpolation rules in `src/terrain/terrainGrid.ts` and the WGS84 math in
`src/camera/cameraMath.ts`. The host owns validation and fallback; the raw
wrapper retains `validationStatus: "unvalidated"`. The actual binary passes 97
mesh cases (172,908 coordinates and target values each) and 178 dense/sparse
height-batch cases (149,158 coordinate pairs) against the retained TypeScript
reference. This is functional evidence, not a speed or
power result. App selection remains explicit and TypeScript remains available.

The Rust kernel builds centre-relative float64 positions, the corresponding
float32 target positions, optional float64 UVs, the original index winding,
the WGS84 centre, and height bounds. It supports a numeric source grid, parent
or child grids, ordered direct neighbours, antimeridian wrapping, and edge
clamping. An absent grid produces zero-height ellipsoid terrain. An empty
neighbour array retains the reference's distinct edge path. Arbitrary height
callbacks without a grid are explicitly unsupported; their caller keeps the
TypeScript path. Callback properties are unused when a numeric grid exists,
as in the reference.

```js
// Execute from an owning module worker. No module is loaded on an inactive path.
import { loadTerrainCore } from "@foss-earth/engine/terrain-WASM";
const core = await loadTerrainCore();
const surface = core.buildSurface({ tile, grid, segments: 64, withUvs: true });
// These arrays are independent copies; the WASM result has already been freed.
// Publish/transfer them with the host's job ID and map generation protocol.
core.dispose();
```

`instantiateTerrainCore(bytesOrModule, options)` injects a prepared module and
the executing worker's trusted Math imports. `createTerrainCore(exports,
options)` exposes the explicit raw ABI boundary. A DOM page is refused. Hosts
without browser `WorkerGlobalScope` may attest `workerRealm: true` from their
worker adapter. That flag is a host assertion, not proof of threading.

The wrapper has no silent JavaScript fallback, fetches only when explicitly
loaded, and performs no rendering. It does not create Babylon meshes or change
terrain settings. The host owns worker startup, cancellation, stale-result
rejection, publication, resource budgets across cores, and any explicit fallback.

All transcendental and rounding functions are imported from this worker's
`Math`: `sin`, `cos`, `atan`, `sinh`, `sqrt`, `pow`, `floor`, `round`, `min` and
`max`. There is no Rust libm substitution or fast-math. Bilinear sums and WGS84
expressions retain reference operation order. Scoped differential checks cover
the executing test realm; hosts compare their first native output before
admission. They do not establish every browser's Math or NaN payload bits. Imported
Math must be trusted and non-throwing. A thrown import may strand a WASM job;
discard that instance and its owning worker. Reentry is explicitly rejected:
the registry is moved out before calling Math, so no `RefCell` borrow crosses
an imported callback.

The ABI is single-threaded and unshared. It bounds mesh segments to 512, tile
zooms to 0–30, grid sides to 4096, direct neighbours to 32, live payload to 128 MiB,
and tracked allocations to 64. The linked memory maximum is expected to be
256 MiB, including Rust stack/allocator overhead; the wrapper rejects a larger
or shared memory. This core must not silently lower resolution when a bound
is exceeded. Source-image decoding retains its independent app limit.

Input buffers are allocated by kind (0=f64 descriptor, 1=f32 heights), and
lengths count elements. Free validates kind, pointer, and exact live length;
arbitrary caller pointers are never dereferenced. `terrain_build` returns a
monotonic result handle. Result slots are 0=f64 positions, 1=f32 targets, 2=f64
UVs, 3=u32 indices, 4=f64 metadata. Metadata is centre x/y/z, min height, max
height, segments, terrain zoom. Missing UVs have zero length and pointer.
`terrain_release_result` releases all result storage together.

The JS boundary snapshots input bytes before allocation, refreshes views after
memory growth, validates spans/alignment/non-overlap, copies output arrays,
and releases every owned allocation in `finally`. Caller height buffers may
be shared, provided nothing writes them while a call snapshots them; decode
workers publish each grid once and never write it again. The host must retain
or copy fallback inputs before transferring them to the worker. Stale freed
pointers must never be reused by callers.

`node terrain-WASM/scripts/build.mjs` writes `single/terrain.wasm` and its
receipt, `build-metadata.json`; `node terrain-WASM/scripts/check.mjs` verifies
them. Successful compilation establishes an artifact, not numerical parity or a
performance result. Source and binary receipts must be refreshed together after
changes.

`core.createHeightSampler(grid)` owns an immutable snapshot for batched height
queries. `sampler.sample(coordinates)` accepts 1–65,536 finite Float64 x/y pairs
in fractional tile coordinates at `grid.z`, returning caller-owned Float64
heights. Keeping these results as f64 preserves interpolated imagery slopes.
Dispose each sampler, then its core, when their owning generation ends.

A grid may supply `indices: Uint32Array` alongside equally sized Float32
`heights` to store only required original pixels. Indices must be strictly
increasing and less than the original `size ** 2`; `size`, tile coordinates,
and ordered neighbour slots retain their original values. Every direct source
then uses this sparse representation, including empty unused neighbours.
Descriptor version 2 packs exact pixel-index/value pairs; all supported pixel
indices through `4096 ** 2 - 1` are exactly representable in the packed f32
index slots. A query needing a missing pixel fails explicitly. Dense snapshots
continue to use descriptor version 1, with the same public sampler method.

The app's imagery worker receives compact snapshots for each batch and frees
its native sampler after that batch. The page resolves the exact required leaf
pixels; the worker still selects source grids, maps the original coordinates
and evaluates the complete interpolation. Both worker arms use these same
inputs. No whole source height array crosses that boundary. At the app's 8,192
point limit, sparse pixels occupy at most 1 MiB, coordinates 128 KiB, and the
native packed pixel copy another 1 MiB plus at most 1,608 descriptor bytes.
Page misses use the immediate complete reference; all live replies must match
those saved exact values before entering the numeric cache. Worker startup,
parity, execution and timeout failures preserve the page reference path.

From the engine root, `npm run check:parity` builds engine, then runs
`terrain-WASM/scripts/check-terrain.mjs` and
`terrain-WASM/scripts/check-height-batches.mjs` against that build. Their reports
go to `build/terrain-WASM/`. The app transfer and lifetime refinement is
recorded in `build/height-sparse-2026-10-18/functional.md`.

Engine exposes an optional renderer-free worker protocol through
`installTerrainMeshWorkerKernel` and `createTerrainMeshWorkers`. Inject this
core as the worker's `native` port and request the `wasm` backend explicitly;
missing native code is an error. The reply identifies the requested and actual
backend and retains `unvalidated` status. The TypeScript backend is a separate
explicit reference request. Host generation checks reject retired map results.
`createTerrainMeshFromGeometry` requires a separate host admission argument:
the TypeScript reference, validated WASM with evidence, or explicitly
experimental unvalidated WASM with a reason. It copies prepared buffers before
handing them to Babylon. No existing terrain runtime selects this path by default.
