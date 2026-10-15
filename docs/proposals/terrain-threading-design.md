# Terrain worker pool design

## Decision

Use a small engine-owned module-worker pool for decode and per-tile array preparation. Keep heights on main for synchronous `heightAt`; give each mesh task a copied center grid and compact halo; return binary64 positions/normals. Babylon objects, seam stitching, scene commits, and GPU uploads stay on main. Start with JS; defer WASM until it passes differential bit tests.

The current seam pass is already schedule-dependent. In-memory replay of `meshRefinement.ts` with Babylon 8.56.2, three coarse/fine patches, and identical targets produced five differing CPU coordinates between one batch and three batches (maximum `1.4210854715202004e-14`). Literal schedule-independent identity with all shipped outputs is therefore impossible. First restore affected patches from immutable unstitched targets and restitch the complete visible set in canonical order. Until then, promise bit identity only for decode and per-tile kernels with identical inputs.

## Critique of the proposed plan

1. `hardwareConcurrency - 1` can still launch fifteen workers beside the main and imagery workers. Keep a main-thread reserve, add a memory cap, and stop at measured saturation; treat 16 as a stress-test size.
2. A main-thread queue cannot be stolen from by workers. Running synchronous kernels cannot be reprioritized or canceled until they yield. Use generation versions, coalescing, checkpoints, and bounded completion queues.
3. Decode currently occupies one of six download slots because `terrainLoader.download()` awaits `decodeTile(blob)` before releasing `active`. Split fetch/body and bounded decode queues to decouple them.
4. `createTerrainMesh` creates Babylon objects and uploads scene buffers. Move only pure arrays; keep binary64 normals, seam stitching, scene mutation, and GPU uploads on main.
5. Worker OffscreenCanvas bytes are not guaranteed to match main-canvas bytes; older Safari lacks support and Safari 16.4 is 2D-only. Feature-test and compare pixels.
6. A cloned `WebAssembly.Module` may be recompiled in each worker, and WASM math needs separate bit proofs. PressureObserver is device-wide and coarse, so it can reduce concurrency but cannot schedule workers.
7. Pages cannot request P/E core placement. `taskpolicy -c background` is not proof of E-core affinity. DevTools throttling here slows main but not workers, and the fixed-loop M5 benchmark is not a tile-kernel benchmark. Validate placement and end-to-end behavior on real devices.

Keep six fetch/body slots, release each after the `Blob` is read, then enqueue decode separately. Cap queued compressed blobs at 4 MiB and pause fetches at the cap; apply the same limit to main-thread fallback.

## Pool size and lifetime

Treat [`hardwareConcurrency`](https://html.spec.whatwg.org/multipage/workers.html#concurrent-hardware-capabilities) as a hint for logical processors the user agent may make available, not as a physical-core count. It may be clamped or privacy-reduced. Treat [`deviceMemory`](https://www.w3.org/TR/device-memory-1/#dom-navigator-devicememory) as a coarse, privacy-rounded estimate, not free RAM; it is absent in some browsers. Do not infer physical core types from either value. An invalid, missing, zero, or non-finite concurrency value becomes `2` for the initial policy, and every input is clamped to `[1, 16]`.

Let `H` be the sanitized concurrency hint and `M` be sanitized `deviceMemory` GiB if exposed. The initial worker ceiling is:

```text
coreCap = H == 1 ? 0 : min(16, H - 1)
memoryCap = M missing ? 4 (provisional; can grow after stable measurements)
           : M <= 2 ? 1
           : M <= 4 ? 2
           : M <= 8 ? 10
           : 16
ceiling = min(coreCap, memoryCap)
initial = min(ceiling, queuedUsefulWork, 2)
```

For `H == 1`, run inline; `H == 2` permits one worker for responsiveness despite contention. Memory tiers are conservative caps, not RAM measurements. Observed throughput may lower the ceiling. If memory is unavailable, start at four workers and grow by two only after 10 seconds of nominal pressure, stable frames, and useful throughput, up to `H - 1`. Live measurements override spoofed or inconsistent hints.

Do not count compositor or GPU-process threads; pages cannot observe a stable reservation for them. Reserve one slot for main (`H - 1`), recognizing that imagery/browser threads still contend. Reduce workers if frame time degrades. The M5 loop plateaus at 10 workers, so a 16-worker pool should be a stress case, not a default.

Create worker one on demand. Add one when queued work is at least `2 × liveWorkers` and estimated wait exceeds 50 ms for 100 ms; space growth by 200 ms. Track decode/mesh EMA (weight 0.2). Stop growing if marginal throughput is under 5% for two 1-second windows or frame p95 misses budget twice. For visible tasks, compare finish estimates including busy-worker remaining time; reserve a busy worker only if it beats the best idle ETA by 15 ms. Allow one reservation per worker and remove it on generation change. Decrease immediately; increase only by these rules.

Retire excess workers after 30 seconds idle while visible; retain one warm worker during an active session. When hidden, pause stale/non-visible work and terminate idle workers after 60 seconds. Never retire an active worker or before transferred buffers are accounted for. Tune these starting durations on browsers.

## Scheduling and frame commits

Use one main-thread priority queue ordered visible, near-visible, required neighbor decode, speculative; then deadline/FIFO. Coalesce by `(tileKey, taskKind, inputVersion)`. During continuous camera motion, reconcile the wanted set at most every 50 ms while retaining only the newest set; publish a generation only when its tile/dependency set changes. Cancel only work outside the visible-plus-neighbor closure.

Pull dispatch naturally gives faster workers more tasks. Use per-worker/per-kind EMA and earliest-finish estimates for visible tasks; ordinary work goes to the next idle worker. Estimates change assignment only. Keep one 64-segment mesh or one decoded tile per task; smaller meshes complicate normal accumulation, while larger batches delay visible work and cancellation. Yield each four rows or 2 ms and check cancellation; yield to the event loop so message tasks can run.

Cancellation is advisory during a kernel: finish the current checkpoint, then return `cancelled`. Main also discards stale generation/input versions. Keep downloads/decode alive while any visible tile still depends on them to avoid camera-move restart storms.

Cap completed meshes at `max(2, 2 × workers)` and 32 MiB; discard stale results first and stop mesh dispatch at the cap. Existing per-frame apply budget remains authoritative, with visible meshes first. Seam restitching shares that budget. GPU uploads and Babylon mutations stay serial on main.

## Height and mesh data ownership

Keep decoded `Float32Array` heights in the main-thread 256-entry LRU because `heightAt` is synchronous and currently has roughly 480,000 calls per load. A worker-owned cache alone cannot answer those calls. The simplest first implementation is a hub model with explicit copies: worker decode transfers the one-megabyte height buffer to the main thread; the main thread keeps it and, when scheduling a mesh, copies the center tile with `slice()` and transfers that copy. For a `514 × 514` extended grid with the center's `512 × 512` interior, the one-pixel halo has 2,052 samples: 512 top + 512 bottom + 512 left + 512 right + 4 diagonal corners. Pack those values in a 16,416-byte float64 array so fractional fallback samples preserve their binary64 value. Resolve halo samples on the main thread through the same `sampleTerrainGrid` implementation so parent-zoom fallback neighbors preserve the current interpolation. Corners, world wrap, polar bounds, and a missing neighbor use the existing sampler's exact edge behavior.

For a 64-segment mesh, the task input is one 1 MiB center copy plus a 16,416-byte halo, about 1.016 MiB per mesh. A single returned `Float64Array` for positions and one for normals total `2 × 4,225 × 3 × 8 = 202,800` bytes; indices are a deterministic 49,152-byte `Uint16Array` generated once on the main thread or cached by segment count. The worker returns no heights because the main thread already owns them. Transfer typed-array buffers in the transfer list, which moves ownership without copying at the messaging boundary; the explicit `slice()` of the center grid is the actual input copy. Worker scratch memory is bounded by active tasks, approximately 1.3 MiB per mesh task before temporary arrays and decoder scratch.

The transfer totals below count typed-array buffers only. They exclude the compressed tile `Blob`, which averages about 85 KiB by the supplied measurement, and exclude protocol messages. A transferred buffer changes ownership and detaches its sender view; do not assume every browser implements that with zero physical memory traffic.

| Model | Bytes moved per tile (decode + one mesh) | Explicit copy cost | 256-tile height memory | Cancellation and eviction |
|---|---:|---|---:|---|
| Main hub with center copy + packed halo (recommended) | ~2,316,368 B: 1 MiB decode result to main, 1,064,992 B task input, 202,800 B geometry result | One 1 MiB `slice()` per mesh; small halo pack; transfer detaches sender buffers | 256 MiB main cache; no persistent worker-height copy; about 21 MiB active task data at 16 workers | Main LRU is authoritative. A task carries tile versions and owns only its copies, so eviction invalidates it cleanly. |
| Worker-local tile cache (option b) | ~1,267,792 B: 1 MiB decode result to main, 16,416 B halo, 202,800 B geometry result | One 1 MiB copy when publishing decoded heights to main and retaining worker cache; no center copy per mesh | 256 MiB main + about 256 MiB for one worker-side copy of each tile; replication across workers can approach `256 MiB × workers` | Route to the owner worker; missing/evicted neighbors need resend. Worker crash loses its cache and requires repopulation. Better only after measurements show center-copy bandwidth matters. |
| Return heights with mesh (option c) | ~1,267,792 B: 1 MiB heights, 16,416 B halo, and 202,800 B geometry result | One 1 MiB copy if worker retains heights after transferring them to main; no center copy per mesh | At least 256 MiB main + 256 MiB worker copies if both keep queries and mesh inputs; up to 512 MiB before replication | Height delivery must survive mesh cancellation. Separate height request IDs from mesh generations. Eviction requires explicit worker invalidation. |
| Send all nine full grids | Up to ~10.2 MiB: 1 MiB decode result, 9 MiB mesh input, ~203 KiB geometry result | Up to 9 MiB copied/packed per mesh if main retains its grids | Main still 256 MiB; temporary task copies can exceed 144 MiB at 16 workers | Simple representation but repeats neighbor interiors and creates large cancellation waste; reject. |

The 2,052-sample halo is a candidate stencil, not proof of equivalence. Test parent fallback, corners, wrap, and edge interpolation against full neighbors. Evict only unpinned main LRU entries; discard results with stale tile versions.

## Core placement, pressure, and platform limits

The page controls task count and timing, not OS affinity, priorities, CPU sets, cpusets, or worker QoS. macOS QoS can influence placement, but browser source defaults differ: [Chromium](https://source.chromium.org/chromium/chromium/src/+/main:third_party/blink/renderer/core/workers/dedicated_worker_thread.cc), [WebKit](https://github.com/WebKit/WebKit/blob/main/Source/WTF/wtf/Threading.cpp), and [Firefox](https://searchfox.org/mozilla-central/source/dom/workers/RuntimeService.cpp). Apple's [guidance](https://developer.apple.com/news/?id=vk3m204o) says placement also depends on workload and system state. The `taskpolicy -c background` run is useful, but **unverified** as E-core pinning; use Instruments/System Trace and inspect renderer/GPU processes.

On Windows 11, Intel Thread Director and the OS scheduler guide hybrid placement ([Intel](https://www.intel.com/content/www/us/en/support/articles/000097053/processors/intel-core-processors.html)); test with Windows Performance Recorder/Analyzer. Android [Energy Aware Scheduling](https://docs.kernel.org/scheduler/sched-energy.html) considers CPU capacity/energy, but target-browser placement is **unverified**. Use Perfetto/System Trace to compare worker counts and core residence on battery and power. Browser source defaults can change, so inspect shipped builds.

Use fewer workers than processors when frame p95, imagery, memory, thermals, or measured throughput demand it. Track frame p95 alongside useful throughput and completion latency.

Use [`PressureObserver`](https://www.w3.org/TR/compute-pressure/) only to lower concurrency: `fair` removes one worker after 2 s; `serious` halves it and stops speculative work; `critical` allows one visible worker. Restore one every 5 s after 10 s nominal. Pressure is coarse, rate-limited, and device-wide; if unavailable, rely on queue delay, frame p95, and throughput. Never change tile quality from pressure.

## Bit identity and kernel boundary

Pool size/order cannot change a pure task's result when immutable inputs, kernel, traversal, and rounding points match and outputs are task-local. Commit only matching versions. Terrarium channel math is exact binary64; `B/256` is binary, and 512-tile multiples of `1/256` fit exactly in float32. Validate alpha before publishing.

Preserve rounding boundaries: sampling, ECEF, positions, and Babylon normal accumulation use ordered binary64. Babylon converts initial updatable geometry to float32 at buffer setup, so do not downcast before normals. Return float64 positions/normals and compare final Babylon buffers; leave later seam/refinement array types unchanged. Pin Babylon 8.56.2 and repeat on upgrades.

Hazards and required catches:

| Hazard | Rule | Test that catches it |
|---|---|---|
| Float reassociation or altered operation order | Keep the same JS expressions and traversal order; no fast-math, reductions, or algebraic rewrites. JavaScript arithmetic must retain specified binary64 results. | Differentially compare every output `Float64` bit and post-Babylon `Float32` bit for fixed fixtures. |
| Float32 boundaries | Assign height once to `Float32Array`; leave mesh positions/normals binary64 through normal accumulation; round where Babylon currently rounds. | Inspect `Uint32Array` views of float outputs at each boundary and final Babylon buffers. |
| `Math.sin`/`Math.cos` | Keep geodetic math in the same JS engine for worker and main paths. [ECMAScript](https://tc39.es/ecma262/multipage/numbers-and-dates.html#sec-math.sin) allows implementation-approximated transcendental results; V8's [fdlibm-derived implementation](https://chromium.googlesource.com/chromium/src/+/main/third_party/fdlibm/README.chromium) does not establish cross-engine identity. Do not replace with WASM libm. | Same browser/version worker-vs-main bit test; separately run Chrome, Firefox, Safari and compare against the stated per-browser baseline. |
| FMA/WASM | Core WASM has no scalar FMA; relaxed SIMD multiply-add may fuse ([spec](https://webassembly.github.io/spec/core/exec/numerics.html#op-frelaxed-madd)). Compiler transforms and another libm also differ. Keep WASM out initially. | If added, test SIMD modes and relaxed SIMD exclusion; inspect instructions and compare bits. |
| Canvas and image decode | `createImageBitmap` options request raw color and unpremultiplied alpha, but worker OffscreenCanvas and main canvas are separate implementations. Alpha 255 avoids alpha round-trip loss; it does not prove all RGB bytes match. [Safari 16.4](https://developer.apple.com/documentation/safari-release-notes/safari-16_4-release-notes) added 2D-only OffscreenCanvas, which still needs runtime feature tests. | For a corpus of real tiles and synthetic channel patterns, compare `getImageData` RGBA bytes and decoded height bits for worker OffscreenCanvas vs main HTML canvas in every supported browser. Reject that worker decode path if any byte differs. |
| Color management | Keep `colorSpaceConversion: "none"`, do not request a changed canvas color space, and confirm readback bytes. The [HTML canvas rules](https://html.spec.whatwg.org/multipage/canvas.html#color-spaces-and-color-space-conversion) describe color-space handling and lossy alpha conversion. | Include boundary RGB values and tiles with profiles; compare byte hashes before and after worker transfer. |
| Arrival order and seam history | Restore from immutable targets and run a canonical full affected-set seam pass. Tile-key sorting alone does not undo prior mutations. | Replay all permutations and batching of the same tile arrivals; compare CPU positions, normals, and uploaded float32 buffers bit-for-bit. |
| Cancellation/retry | Versions prevent stale output from committing; retries use the same input snapshot. | Cancel at each worker yield point, retry on another worker and inline, then compare output bits. |

Standards do not promise cross-browser identity for trig or canvas decode. Guarantee worker/main JS identity per validated browser build and keep per-browser goldens. Cross-browser bit identity requires specified deterministic trig and byte-defined image decode.

## Failures and startup

Create module workers via `new Worker(new URL("./terrainWorker.ts", import.meta.url), { type: "module" })`; catch CSP/constructor and worker `error`/`messageerror`. If unavailable, use the current main path or chunk pure kernels between frames. Feature-test worker OffscreenCanvas/2D; if missing or bitmap creation fails, decode on main while retaining worker mesh tasks.

On crash, reject the task and retry once from main-owned inputs on another worker; then fall back inline. Never retry stale/canceled work or transfer the only cached heights. Bound retries and count failures.

When hidden, pause speculative work and resume the latest generation. Under memory pressure, shrink the pool, evict idle worker caches, close bitmaps, and reduce the main LRU toward 128 entries without evicting visible/query-pinned grids. One-core devices stay inline; two-core devices get at most one worker and disable it if measured slower. Lazy creation spreads parse cost. Do not compile WASM per worker: [`WebAssembly.Module`](https://webassembly.github.io/spec/web-api/index.html#serialization) cloning may compile in each realm; reuse is an optimization, not a guarantee.

## Performance model

The M5 measurements divide into parallel-candidate `P = 0.57 s decode + 0.40 s mesh = 0.97 s` and conservatively serial `S = 3.00 - 0.97 = 2.03 s`. Counting all mesh prep as parallel is optimistic because seams/uploads remain serial. With measured `g(N)=[1.05,2.1,4.2,6.9,8.1]`, CPU-phase time `S+P/g(N)` is `[2.95,2.49,2.26,2.17,2.15] s` for 1/2/4/8/16 workers. Main CPU stays ~2.03 s plus overhead. Sixteen adds no throughput over ten; 8/16 rows are stress projections when the production cap is lower.

| Device scenario | Worker count N | Modeled CPU-phase completion (s) | Modeled main CPU (s) |
|---|---:|---:|---:|
| M5 measured baseline work | 1 / 2 / 4 / 8 / 16 | 2.95 / 2.49 / 2.26 / 2.17 / 2.15 | ~2.03 each |
| 8-core Android scenario | 1 / 2 / 4 / 8 / 16 | 12.00 / 10.06 / 9.56 / 9.07 / 9.07 | ~8.12 each |
| 4-core low-end scenario | 1 / 2 / 4 / 8 / 16 | 18.00 / 15.09 / 14.33 / 14.33 / 14.33 | ~12.18 each |

Only M5 throughput and CPU are measured. Android is an **unverified scenario**: M5 work ×4, two fast cores and six little cores at 0.35 (`g=1,2,2.7,4.1,4.1`). Low-end is **unverified**: ×6, two fast plus two little at 0.35 (`g=1,2,2.7,2.7,2.7`). Neither models main/imagery contention. Ideal pipeline overlap lies between `max(S,P/g)` and `S+P/g`; network, startup, apply, shaders, and GPU widen actual settle time.

The warm-cache M5 run settled in 3.788 s (3.059 s main busy; 595 terrain/220 imagery requests; 1280×720). If all saved CPU is critical-path work, modeled settle is 3.74 / 3.28 / 3.05 / 2.96 / 2.94 s; actual gain ranges from zero to that ceiling, minus startup/copy/commit overhead. No defensible Android or generic four-core wall estimate exists: the phone proxy used 953 terrain/161 imagery requests, 1081×2401, and software GL. Treat the table as CPU-phase projections. Shader compilation (0.9 s), engine setup (0.6 s), Babylon creation, seams, and uploads remain serial. Then `heightAt`/selection sampling and frame-budgeted commits likely dominate; measure them.

## Implementable protocol

```ts
type TileKey = `${number}/${number}/${number}`;
type TaskKind = "decode" | "mesh";
type Priority = 0 | 1 | 2 | 3; // visible, near-visible, neighbor, speculative

interface TileRevision { key: TileKey; inputVersion: number }
interface TileVersion extends TileRevision { generation: number }
interface MeshInput extends TileVersion {
  kind: "mesh"; priority: Priority; segments: 64;
  center: Float32Array; // task-owned copy
  halo: Float64Array;
  neighbors: readonly TileRevision[];
}
interface DecodeInput extends TileRevision { kind: "decode"; priority: Priority; blob: Blob }
type WorkerRequest =
  | { type: "run"; id: number; task: DecodeInput | MeshInput }
  | { type: "cancelBeforeGeneration"; generation: number }
  | { type: "cancel"; id: number } // decode only when it has no remaining consumers
  | { type: "dispose" };
type WorkerReply =
  | { type: "ready"; workerId: number }
  | { type: "decoded"; id: number; tile: TileRevision; size: number; heights: Float32Array }
  | { type: "mesh"; id: number; tile: TileVersion; positions: Float64Array; normals: Float64Array }
  | { type: "cancelled"; id: number }
  | { type: "failed"; id: number; message: string };

interface TerrainWorkerPool {
  submitDecode(task: DecodeInput): Promise<{ size: number; heights: Float32Array }>;
  submitMesh(task: Omit<MeshInput, "kind">): Promise<{ positions: Float64Array; normals: Float64Array }>;
  setWanted(generation: number, keys: ReadonlySet<TileKey>): void;
  setPressure(state: "nominal" | "fair" | "serious" | "critical"): void;
  dispose(): void;
}
```

The main thread owns IDs, queue, wanted generations, height LRU, worker health, and Babylon commits. Workers own only active task copies and reusable decode canvas. Validate every response's ID, key, generation, input version, lengths, alpha result, and transfer-buffer attachment before use. Give each active worker one task; no hidden worker-side priority queue.

```text
onWantedSet(generation, keys):
  publish generation and keys once
  remove queued tasks not needed by keys or pinned neighbor/decode requests
  send cancelBeforeGeneration(generation) to active workers

dispatch():
  while an idle worker exists and resultBytes < 32 MiB:
    task = highest priority, earliest deadline, FIFO task
    if task is critical-visible:
      worker = argmin(estimatedAvailableTime + EMA(worker, task.kind))
      if worker is busy and worker ETA beats best idle finish by >= 15 ms:
        reserve task for worker; dispatch the next task to an idle worker; continue
    else:
      worker = argmin EMA(worker, task.kind) among idle workers
    send task with owned transfer buffers; mark worker busy

onReply(worker, reply):
  validate id and input versions; release task-byte accounting
  if stale/cancelled: discard buffers
  else if decoded: store heights in main LRU; notify dependents
  else if mesh: enqueue bounded main-thread apply
  else if failed/crashed: retry once from main-owned inputs, then inline fallback
  mark worker ready; update per-kind EMA; dispatch()

onFrame():
  admit high-priority finished meshes within existing time budget
  create Babylon objects and upload buffers on main thread
  restore affected patches from immutable targets; canonical restitch
  never commit a stale generation
```

## Test matrix

1. Unit tests with fake workers: priority ordering, coalescing, versions, buffer transfer accounting, cancellation before/after each yield, stale response rejection, crash/retry/inline fallback, queue caps, idle retirement, pressure transitions, and disposal.
2. Differential tests: real Terrarium corpus and synthetic RGBA patterns; main vs worker decode bytes/heights; old vs worker positions/normals/intermediate Babylon buffers; halo vs full-neighbor `sampleTerrainGrid`; all seam arrival permutations after canonicalization; cancellation/retry and every pool size produce identical hashes.
3. Browser matrix: current Chrome, Edge, Firefox, Safari desktop and iOS Safari, plus low-memory Android Chrome/Firefox. Override `hardwareConcurrency` to 1–16 and separately test `deviceMemory` missing/2/4/8/16, Worker/CSP failure, OffscreenCanvas absence, hidden/visible transitions, and memory-pressure behavior. Feature-test module workers and OffscreenCanvas in the actual worker, not only on the window.
4. Performance runs: fixed tile corpus, fixed camera path, fixed cache/network mode, record main CPU, worker CPU, time-to-first-visible-tile, settled time, p50/p95 frame time, worker startup, copied bytes, peak retained heights, upload time, and discarded stale work. Compare 0/1/2/4/8/10/16 workers. On Apple Silicon, compare normal scheduling and `taskpolicy -c background`, while Instruments verifies actual core residency. On Android and Windows hybrid hardware, capture per-thread core residency with Perfetto and Windows Performance Analyzer. Report the machine, browser build, OS, power mode, and process/thread used for each result.

The first release gate is correctness plus main-thread responsiveness, not a promised speedup: enable mesh workers only after per-browser bit tests pass, keep decode on the main fallback where worker canvas differs, and leave WASM disabled. Promote the full-scene bit-identity claim only after seam history is canonical and its permutation tests pass.
