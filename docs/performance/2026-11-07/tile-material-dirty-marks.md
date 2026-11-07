# Map tile materials without wasted dirty marks — 7 November 2026

P-123 in the performance ledger. Engine `460736b`; baseline engine
`ef4e134`, Babylon 8.56.2. Not an item of the performance limits audit: it
came from a CPU profile of the 0SFS flight app, with the map streaming
under the aircraft.

## What it was

Babylon marks a material dirty by walking every mesh in the scene and each
of its submeshes, looking for the ones that draw with that material
(`Material._markAllSubMeshesAsDirty`, and `markDirty`). The cost grows with
the scene's mesh count, whether or not anything uses the material.

Each map tile's material was marked dirty four times when nothing could
use it:

- three times while `createTileRecord` set it up, before its mesh took it:
  - the imagery atlas plugin's `setAtlas` (or, without the atlas, the first
    `diffuseTexture`);
  - `disableLighting`;
  - `backFaceCulling`;
- once when the tile was let go, in the managed atlas's `detachPatch`
  (`setBinding(null, null, null)`), just before the material and mesh are
  disposed.

In a CPU profile of fly in flight (WebGL2 globe, M5, 10 s), these walks were
the largest self time after idle: `_markAllSubMeshesAsAllDirty`,
`_markAllSubMeshesAsDirty`, `_markAllSubMeshesAsLightsDirty` and
`markAsDirty`, 35.6 and 39.0 ms/s in two runs. By caller:

- `attachPatch`, 13.5 ms/s;
- `detachPatch`, 10.3;
- `disableLighting`, 10.3;
- `backFaceCulling`, 9.4.

## What changed

- `createTileRecord` blocks the new material's dirty marks
  (`blockDirtyMechanism = true`) as soon as it exists. It clears the flag
  just before the mesh takes the material.
  - Babylon's public setter would then call `markDirty()`, one more walk that
    finds nothing, so the flag is cleared directly (`_blockDirtyMechanism`).
  - If a Babylon release renames that field, the code falls back to the
    public setter.
- `disposeRecord` blocks the material before the detach. The material and its
  mesh are disposed in the same cleanup.

## Why it is exact

While a material is blocked, Babylon skips only three things:

- `_markAllSubMeshesAsDirty`: the walk. It changes only the draw wrappers of
  submeshes that use the material. During setup, none does: the mesh takes
  the material on the last line, and Babylon's default material is never
  this one. On disposal, the only mesh using it is the tile's own, which is
  disposed next.
- `markAsDirty`: the walk, then `scene.resetCachedMaterial()`.
  - The scene's bind cache is read only while binding
    (`isCachedMaterialInvalid`).
  - `scene.render()` resets it at its start, before any render target or
    camera draws, and `_renderForCamera` resets it again for each camera.
  - The map's update runs in the renderer's `prepare`, just before
    `scene.render()` (`rendererLifecycle.ts`).
  - Setting up a material binds nothing, and the new material has never been
    bound, so it cannot be the cached one. The reset it skips was redundant.
- `_markScenePrePassDirty`: none of the properties set here calls it.

Nothing else in Babylon reads the flag.

## Proof

- **Differential harness** (`build/material-dirty/diff.test.ts`).
  - The runtime as at `ef4e134` and the working tree each drive their own
    NullEngine scene through the same tour:
    - six views (Grand Canyon, Seattle, the whole Earth), 108 frames;
    - a real terrain lighting plugin;
    - a region tint set and cleared;
    - 40 other meshes, half with a material of their own;
    - one legacy texture in seven failing.
  - After every update and every render, it compares the scene's whole
    material state:
    - every mesh's material and its properties;
    - plugins and the imagery binding;
    - each draw wrapper's defines, dirty flags, readiness and effect
      defines;
    - after each render, the bind cache.
  - Three modes:
    - the managed atlas the app uses: 386 tiles made, 226 disposed;
    - the unmanaged atlas;
    - legacy textures: 393 made, 235 disposed.
  - 84,000 to 87,000 lines of state per mode, all identical. The A/A run (`AA=1`)
    passes.
  - Walks on tile materials:

    | Mode | Before | After |
    | --- | ---: | ---: |
    | Managed | 1,704, of which 1,158 found nothing | 320, none empty |
    | Atlas | 1,478 | 320 |
    | Legacy | 1,335 | 156 |

    The walks left are exactly those that reach a shown tile. No blocked
    mark would have reached a mesh that stays.
- **`tests/rasterTileMaterialDirty.test.ts`**, five tests:
  - Managed and legacy: no walk on a tile material finds nothing, and a
    blocked mark reaches only meshes that are then disposed. The block
    counts are exact: three per tile made, plus one per tile disposed with
    the managed atlas.
  - A shown tile's draw defines go dirty when the first region tint
    recompiles the map's materials (managed), and when a property changes
    (legacy).
  - The fallback through the public setter, for a material without the
    private field.
- **Mutants** (`build/material-dirty/mutants.py`): 11 of 11 caught.
  - Caught by both the tests and the harness:
    - the material never unblocked;
    - unblocked only with the atlas;
    - the scene's marks blocked instead of the material's.
  - Caught by the tests only (they change no state, only the walks):
    - unblocked through the public setter;
    - the fallback inverted, or missing;
    - not blocked at setup;
    - blocked only after the plugins and the patch;
    - not blocked before the detach;
    - blocked after the detach;
    - unblocked again after disposal.
- Engine `npm run typecheck`, lint, and the whole suite pass: 140 files,
  1,522 tests.

## Measured

**Node 22 on the M5** (`build/material-dirty/bench.test.ts`). One walk on a
material nothing uses, medians of 9 rounds of 5,000:

| Meshes in the scene | One walk |
| ---: | ---: |
| 100 | 0.50 µs |
| 500 | 5.20 µs |
| 2,000 | 23.7 µs |

Each tile now skips three walks when it is made, and one more when the
managed atlas lets it go.

The harness's whole managed tour, with 1,000 extra meshes, took 341 ms
before and 304 ms after (`runtime.update()` only, medians of 9 interleaved
rounds). The rounds ranged from 240 to 391 ms, too wide to say more than
that. With 40 extra meshes the tour did not move (262 and 259 ms). These are
Node timings, not frame rates.

**Chrome on the M5.** fly `75b4ce0` (with the uncommitted work in the fly and
engine checkouts), built twice with only `createRasterTilesRuntime.ts`
different. Headless, Metal, the default start, interleaved before, after,
after, before, under the perf lock. Builds and reports:
`0sfs/fly/build/material-dirty/`. CPU profiles: `research/build/benchmarks/startup-audit/profile-fly-md-*/`.

CPU profile (research's `profile.mjs`, WebGL2 globe, Canvas 2D attitude
indicator, 10 s, 59 fps in every run):

| Run | Material dirty marks, self | Main thread | Script | `attachPatch` | `detachPatch` |
| --- | ---: | ---: | ---: | ---: | ---: |
| before 1 | 35.6 ms/s | 36 % | 27 % | 12.8 ms/s | 15.3 ms/s |
| after 1 | 0.1 ms/s | 32 % | 23 % | 1.4 ms/s | 6.8 ms/s |
| after 2 | 0.1 ms/s | 32 % | 23 % | 1.4 ms/s | 7.1 ms/s |
| before 2 | 39.0 ms/s | 39 % | 29 % | 14.2 ms/s | 16.9 ms/s |

The `attachPatch` and `detachPatch` columns are inclusive. What `detachPatch`
has left is its own release work.

Frame profiler (`scripts/profile-flight.mjs --runs=webgpu-webgpu`,
`--headless`, 10 s after a 5 s settle, 599 frames in each run):

| Run | `map/raster tiles` mean | p95 | `measured` mean |
| --- | ---: | ---: | ---: |
| before 1 | 1.292 ms | 5.5 ms | 4.546 ms |
| after 1 | 1.132 ms | 4.6 ms | 4.290 ms |
| after 2 | 1.062 ms | 3.9 ms | 4.061 ms |
| before 2 | 1.270 ms | 5.9 ms | 4.349 ms |

The section counts only the map's update. The detach runs in the host's work
passes, outside it. The page's timer has 0.1 ms resolution. Nothing was
measured on a phone; the cost of a walk there scales with the same mesh
count.

## Left

- The walks that remain on shown tiles are real marks: imagery binding
  changes, region tints and lighting changes. Each still walks every mesh to
  find its one tile, because that is how Babylon finds a material's
  submeshes. Marking the tile's own submesh would avoid the walk, but it
  would copy Babylon's internals. That is not started.
- Other per-tile materials in the engine (3D tiles, overlays) were not
  profiled for this pattern.
