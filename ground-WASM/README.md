# ground-WASM

The Rust twin of [ground-TS](../ground-TS/groundBvh.ts). Rust builds immutable
median-split triangle BVHs from the displayed Float32 positions, and answers
bulk finite rays with Float64 arithmetic. The index is ground-TS's, bit for
bit: the same nodes in the same order, the same bounds down to the sign of
zero, and the same face order in every leaf. The triangle
loop follows the installed Babylon `Ray.intersectsTriangle`: determinant
zero check, reciprocal multiplication, epsilon barycentrics, inclusive ray
length, and first original face on tied distances. BVH traversal preserves
face IDs despite partitioning. The actual binary and its exported immutable
index passed focused differential checks against Babylon over 514 deterministic
finite rays, nonplanar Float32 triangles, oblique directions, boundary samples
and original-face ties. It also adopts an exported index without rebuilding
it, and answers world rays for one mesh as Babylon's `scene.pickWithRay` does,
transform, distance and normal included (below).

Load in a browser worker or Node worker, then call `buildBvh` or
`importSnapshot`, and `query` or a world batch. The page main thread is
refused unless `loadGroundCore`, `instantiateGroundCore` or
`createGroundCore` is given `{ page: true }`: world picks answer a frame's
synchronous queries, which a worker cannot. Until world batches, no Rust export
ran on the page; that is now the page's choice, per core, and the core reports
it as `page`. Inputs and outputs are copied, except a world batch's `rays` and
`output`, views of WASM memory replaced when it grows. Each BVH owns its geometry until `dispose()`;
dispose the old generation only after the host has released all references.
There is no shared memory, atomic publication, or concurrent Rust access in
this version. The host supplies job IDs, cancels stale jobs and keeps using
the existing synchronous picker until an admitted generation is ready.

`snapshot()` copies the immutable traversal index to caller-owned Float64
storage: header `[nodeCount, faceCount]`, ten values per node
`[lowX, lowY, lowZ, highX, highY, highZ, left, right, start, count]`, followed by
original face IDs. Internal nodes have `count=0`; leaves address the face list.
This allows synchronous TypeScript traversal of a worker-built Rust index
without running WASM or waiting for a worker in a physics step.

ABI v1 uses registry-owned typed allocations (kind 1 Float32, 2 Uint32,
3 Float64). Lengths count elements. Unknown pointers, kind/length mismatches,
double releases and aliased ray/output buffers are rejected.
`ground_import_snapshot`, `ground_set_bounds` and `ground_query_world_batch`
joined v1 without changing the other exports, and `build.mjs` refuses a binary
that lacks any the wrapper requires. A failure's status, the thrown error's
`status`, is 1 invalid argument, 2 allocation, 3 geometry, 4 unknown mesh,
5 rays, 6 snapshot or 7 transform. Limits are
262144 triangles, 1048576 vertices, 65536 rays per batch, 64 BVHs, 64 transient
buffers, 128 MiB live payload and 256 MiB linear memory. No caller-provided
pointer is dereferenced. The wrapper refreshes views after memory growth and
copies output before freeing. It never selects a JavaScript fallback silently.

`query` operates in mesh-local coordinates; its `ray parameter` is not a world
distance under a scaled transform. World batches take over the transform,
world distance and normal. Scene eligibility, mesh order, transform inversion,
height conversion, the raster grid walker and per-frame ground cache still
belong to the host integration. Engine's `createGroundAcceleration` now
integrates those synchronous queries through `createSurfaceQuery`'s optional
sixth argument. Static indexed Float32 Mesh/GroundMesh geometry with one full
triangle submesh is eligible; pending, changing, morphed, skinned, instanced,
camera-dependent and custom-picking meshes use the original picker. Geometry
updates invalidate synchronously, stale build generations are dropped, and
each index is validated against its mesh before it is used (Admission, below).
Mesh transforms and normals are evaluated in the current synchronous frame.

## Admission

The engine worker builds with TypeScript or Rust through the same transfer
path, with bounded startup and one job at a time. The app creates the worker
for its first mesh. In the Rust arm the worker starts loading the core at once,
and before it builds any mesh the core must build a fixed fixture's index
exactly as `buildGroundBvh` does, compared with `Object.is`: 1,088 faces with
repeated and degenerate faces, -0 and +0 centroid ties at the root median, and
nodes of 17 faces. Otherwise the worker builds with TypeScript and reports
`startup-parity-mismatch`, or `wasm-build-failed` if the core failed or
trapped.

After admission each mesh is built once, by Rust, and its index is validated
against the mesh: every leaf's box must contain its faces' corners and every
node's box its children's. `queryGroundBvh` reaches every face whose hit is no
farther than its best and breaks distance ties by face, so on any such index
it gives the reference's hits, whatever the tree's shape. A mesh whose index
fails is built with TypeScript, and so is every later one
(`wasm-index-invalid`). The page validates each index the same way before
using it; what it rejects stays in its report. Comparing each mesh's first
query with Babylon's own pick of that mesh is a diagnostic, off unless
`compareFirstQueries` is set: validation already gives Babylon's hits, and the
comparison scans every triangle of a tile on the frame its index arrives.
Builds run one at a time, in the order the page asked for them: the page keeps
up to eight meshes in flight and the preparer and worker queue up to sixteen,
so the tiles under several rays are all built in turn. A build refused for a
full queue is asked for again by a later query, not counted as a failure.
The WASM handle is released after exporting each index. Runtime reports
separate the actual construction kernel from synchronous TypeScript queries,
along with copy/work/round-trip counts. Raster
latitude/longitude samples keep their existing cell walker and the flight
ground cache is unchanged. Whole-family W6 and in-app performance
qualification remain incomplete.

## The same index with less work

ground-TS sorts every node's faces by centroid on its longest axis, comparing
by subtraction, so -0 and +0 tie and the lower face goes first. It splits at
half the count, rounded down, stops at 8 faces, numbers nodes in pre-order and
takes bounds with `Math.min` and `Math.max`, which order -0 below +0. Rust
reaches the same index this way:

- Each face becomes one item: integer keys that order its three Float64
  centroids as `f64::total_cmp` does, except that -0 equals +0, its Float32
  bounds and its ID. Equal keys fall back to the ID, so the order is total.
- `select_nth_unstable_by` partitions each node around its median in linear
  time instead of sorting it. A half of 8 faces or fewer is a leaf, so it is
  then sorted completely, as the reference leaves it.
- Bounds use WebAssembly SIMD `f32x4.min` and `f32x4.max`, which order zeros
  as `Math.min` and `Math.max` do. Float32 positions make Float32 face bounds
  exact.
- A median split's node count is known in advance, so items, nodes, triangles
  and face IDs are each reserved once, within the memory budget, before the
  build starts.

## Importing a snapshot

`importSnapshot(snapshot, positions, indices)` adopts an index as it is, so a
holder of ground-TS's or an exported snapshot gets a WASM mesh without a
build. It reads the snapshot once, depth first from the root, and sorts
nothing: the same nodes, bounds and face order, so `snapshot()` returns it bit
for bit and queries give the same hits. It accepts what `validateGroundBvh`
accepts with the geometry: every node reached once from the root, the leaves
holding a permutation of the faces, finite ordered boxes inside their parents,
and every leaf's box holding its faces' corners. It is stricter in two ways.
Fields traversal ignores, a leaf's children and an internal node's start, must
still be indices, and no leaf may lie deeper than 48 levels, which bounds the
traversal stack; median splits stay under 20. Anything else fails with status
6 and keeps nothing. Triangle edges and origins and Babylon's face normals are
computed once, as in a build. Memory is accounted as for a build of the same
mesh, plus a byte per node and per face while the import validates.

## World picks

`createWorldBatch(capacity)` allocates rays and hit rows in WASM memory once.
The host fills `rays` with world rays `[origin xyz, direction xyz, length,
epsilon]`, calls `reset()`, then `run(mesh, transform)` for each eligible mesh
in the scene's order. The rows then hold what `scene.pickWithRay` with that
predicate and `getNormal(true, false)` give: `[mesh handle, distance, face, bu,
bv, point xyz, unit normal xyz]`, mesh 0 for none. `mesh.queryWorld(rays,
transform, previous)` does the same with copies. For each ray, as Babylon
8.56.2 does it:

- `Ray.TransformToRef` by `worldToLocal`: the origin as coordinates, the
  direction as a normal, normalised with the length scaled unless its length
  is 0 or 1.
- The bounding sphere, then the box, then the BVH, whose traversal tests both
  children of a node at once with f64x2 slab tests. `setBounds` gives the
  host's `getBoundingInfo()` as mesh-space minimum, maximum, sphere centre and
  radius; until then the root box stands in.
- The point is the local hit transformed by `localToWorld`, the distance its
  world distance from the transformed origin, and a barycentric that is not a
  number becomes 0, as `bu || 0` makes it.
- A row changes only for a hit nearer than the one it holds, so the first mesh
  wins a tie, as in the scene.
- The normal is Babylon's `(v1 - v2) × (v3 - v2)` by `normalToWorld`, flipped
  when it runs along the ray, then normalised.

`normalToWorld` must be the matrix `getNormal` uses: the world matrix, or under
non-uniform scaling the translation-free inverse transpose it computes in
`TmpVectors.Matrix`, which stay Float32Array when the engine uses
high-precision matrices. It defaults to `localToWorld`. Matrices are passed as
the scene stores them; the core neither fuses nor reorders arithmetic.

## Evidence

`npm run check:parity` runs `scripts/check-index.mjs`, which builds 13 meshes
with this binary and with the built ground-TS: four terrain grids of 7,938 to
262,088 faces, one jittered; triangle soups of 9, 20,000 and 200,000 faces with
repeated and degenerate faces, signed zeros and magnitudes up to 5 × 10^5; soups of
17, 139, 1,088 and 139,264 faces, where a 17-face node's 8-face half becomes a
leaf straight from a median selection; and two meshes with exact -0 and +0
centroid ties. Every snapshot value must match with `Object.is` (3,116,493
values), and 4,096 rays per mesh must give the same hits, distances, faces and
barycentrics. The report goes to `build/ground-WASM/ground-index-parity.json`.
Engine's `tests/groundAcceleration.test.ts` repeats the identity check at 139
and 1,088 faces and compares hits with Babylon's ray-triangle test. It runs the
worker as the app does and checks that admission refuses a looser bound and a
zero of the other sign, that the only TypeScript build is the fixture's, that
an index not containing its mesh or a core that traps leads to TypeScript
builds, and that the page keeps reporting what it rejected. It also checks that
a one-leaf index and one with every box enlarged give the reference's hits.

`check-index.mjs` also imports each ground-TS snapshot and compares its round
trip and hits. It feeds the import 20 broken snapshots, 18 that ground-TS
rejects and 2 that only the import refuses, a 48-level caterpillar index that
imports and a 49-level one that does not, a valid reordering, which is adopted
as it is, and boxes padded past the float64 range by an epsilon of 10^307 or
bounds of ±10^308. It checks the page guard with a stand-in `document`. Then it
runs `scripts/check-world.mjs` once per matrix precision, since
`PerformanceConfigurator.SetMatrixPrecision` holds for a process, against
Babylon 8.56.2's `scene.pickWithRay` and `getNormal(true, false)` on a
NullEngine: grids of 4,418 and 1,058 faces and a 1,500-face soup with unused
vertices, under seven transforms (identity, far ECEF translation, rotation,
uniform and non-uniform scale, mirrored, and mirrored non-uniform), each with
Babylon's bounding info and, where the root box equals it, the default, plus
three meshes and a duplicate picked in the scene's order. All 636,416 row
values of 57,856 rays (28,802 hits) match with `Object.is` at each precision,
and `queryWorld` matches the batch.

The binary that moved here from the old shared Rust workspace (`1fb1c9d0…0e0a`, 30,911
bytes) gave the same hits on all 13 meshes and the same index on six of them,
the four terrain grids among them. On the other seven its index differed:
zeros of the other sign in bounds (17 values at 20,000 faces, 180 at 200,000),
a different face order in the leaves of 17-face nodes (3,016 leaves at 139,264
faces), and a different tree where centroids were -0 and +0. Its first-use
check compared hits only. This build replaced it on 19 October 2026.

## Performance

Measured with `scripts/bench.mjs` in Node 26.9.0 on an Apple M5 with 16 GB, one
process per run, on terrain grids: the median of 15 builds after a first one.
This is the kernel alone, not the worker round trip, a browser or the app.

| Faces | ground-TS | Previous binary | This binary |
| ---: | ---: | ---: | ---: |
| 7,938 | 6.8 ms | 1.41 ms | 0.54 ms |
| 32,258 | 32.2 ms | 7.07 ms | 2.78 ms |
| 130,050 | 148.8 ms | 32.6 ms | 12.5 ms |
| 262,088 | 307.5 ms | 69.4 ms | 26.0 ms |

Exporting the snapshot and validating it against the mesh adds 0.15 ms at
7,938 faces and 4.2 ms at 262,088. The page's validation of the same index, on
the main thread, takes 0.30 ms and 5.7 ms.

The first mesh waits for the worker to load and admit the core, then for its
own build. `bench.mjs first` times it as the app sends it, with the app's
preparer and worker, in one fresh process per run (the median of 7). The
previous worker, at engine `996ba1b` with the previous binary, also built the
first mesh in TypeScript to compare the two:

| Faces | Previous first mesh | First mesh now | Second mesh now |
| ---: | ---: | ---: | ---: |
| 7,938 | 18.3 ms | 7.8 ms | 3.2 ms |
| 32,258 | 50.5 ms | 12.0 ms | 5.9 ms |
| 130,050 | 188.8 ms | 26.3 ms | 16.9 ms |
| 262,088 | 386.1 ms | 46.2 ms | 32.3 ms |

Admission takes 4.3 ms in a fresh process: instantiation 0.3 ms, the fixture
0.4 ms, its TypeScript build 2.6 ms, and its WASM build and comparison
0.95 ms. Compiling the module takes 0.17 ms in a fresh Node process, so
streaming compilation would save little. These timings were taken on battery
in Low Power Mode; the kernel timings above reproduced within 1% that way.
They were taken with the 49,399-byte binary that preceded import and world
batches.

`bench.mjs import` and `bench.mjs world` were run on AC power while charging,
so compare them with each other, not with the tables above. Importing
ground-TS's index of the 262,088-face grid takes 3.70 ms, against 24.8 ms to
build it in WASM (medians of 15, copies in included; the first of each, 7.2
and 33.3 ms). World picks of that grid placed at an ECEF position, with 1,024
vertical rays at epsilon 0.001 that all hit, take 251 and 269 ns per ray in two
runs. The TypeScript path the page takes today (`Ray.TransformToRef`, the
bounding tests, `queryGroundBvh`, the point and `getNormal`) takes 541 and
560 ns, so the batch is 2.1 to 2.2 times as fast. Babylon's own brute-force
`pickWithRay` takes 4.0 to 4.1 ms per ray. Alternating in one process over
4,096 mixed rays, copies included, the local `query` is 4 to 8% faster than
the previous binary's in five runs. Storing both children's boxes side by
side, so that each pair test loads whole lanes, gained nothing measurable and
was not kept.

`node ground-WASM/scripts/build.mjs` rebuilds `single/ground.wasm` and its
receipt offline; `node ground-WASM/scripts/check.mjs` verifies them. After
`npm run build`, `node ground-WASM/scripts/bench.mjs <ts|wasm|first|import|world> [grid size]`
times one build kind or the first mesh, `import` an import against a build and
`world` world picks; `GROUND_WASM=<file>` times another binary.
