# Managed Atlas runtime source contract

This interval implements source only. Every new fixture, typecheck, lint, build,
installed consumer, browser/backend behavior and current application adoption is
UNRUN. The source receipt is not a package or admission qualification.

`@foss-earth/engine/babylon` exports the additive
`ManagedImageryAtlasResources`, `ManagedImageryAtlasOptions`,
`ImageryAtlasGpuTicket`, `OwnedImageryTableJob` and `ImageryAtlasDisposal`.
`createImageryAtlas(scene,layout,anisotropy,device,managed?)` uses the actual
Renderer `prepareRawTextureBatch` capability; no void adapter authorizes it.
`ImageryRuntimeOptions.managedAtlas` flows through the existing
`RasterTilesRuntimeOptions.imageryPorts` and `GlobeRasterPorts.imageryPorts`.
`restoreManagedDevice()` is a supplied replacement adapter after actual observed
loss, rather than reusing a loss-ended tracker. Missing completion capability
still refuses managed records before native allocation. Plain legacy records,
old device operations, page/gutter/mip generation, binding math, selection and
request policy remain available unchanged.

The host supplies one existing Images broker and one actual Renderer backend.
It binds these ports to that broker, without a new pool or authority:

- `generation()` returns the broker generation.
- `reserveGpu(bytes,label,{overlap})` reserves directly through
  `broker.pools.reserve('sourceGpu',bytes,label,{overlap})`, returning the actual
  grant with `release()` and `settle()`, or null. The entire Atlas mip storage and
  full physical page-table texture are admitted before either texture exists.
- `reserveTable(bytes,label)` reserves decoded bytes for a full persistent or
  candidate CPU table before allocation, returning a grant or null.
- `reserveCopy(bytes,label)` reserves decoded bytes for Renderer's actual private
  immutable snapshot before allocation. It returns a grant or throws the actual
  capacity failure. It never returns null or creates an uncharged snapshot.
- `canUpload(bytes,additionalDecodedBytes=0)` checks the same pool's
  `fits('uploadOutstanding',bytes)` and
  `fits('decoded',bytes+additionalDecodedBytes)`. Renderer's tracker `admit` must
  reserve `uploadOutstanding` directly through those same pools.
- `subscribeAvailable(callback)` uses those pools' public availability event;
  return its unsubscribe. `capacityKey()` encodes those same pool limits and
  reserved totals, excluding peaks. The runtime suppresses its own unchanged
  temporary-candidate release wakes. Native retirement and real capacity changes
  wake the existing host frame; original retry deadlines use the supplied clock
  and timer. This code adds no polling clock, broker, scheduler or renderer.

`@foss-earth/engine/imagery` adds `OwnedImageryNativeJob`,
`OwnedImageryUploadJob`, `HeldPatchTable`, `ManagedPatchTablePorts` and
`prepareManagedPatchTable`. `ImageryPageStore.prepareOwnedUpload` and
`ImageryAtlas.prepareOwnedTable` are optional additive ports.

A held image becomes `uploading`, rather than resident, while one complete batch
of all pages and the original five mip regions is submitted. All native byte and
snapshot admission precedes copying or native work. Prepared input, copy grant,
upload grant, slots, source/entry identity and captured Atlas generation survive
partial throw, cancellation, reset and unknown completion. `settled` establishes
an outcome; `retired` separately proves native completion or observed loss.
Only complete successful native retirement in the current demanded source,
entry, Atlas and slot generation acknowledges residency and counters. A rejected
completion proves failure but does not prove retirement. Disposal requests native
cancellation and retains coordinates and GPU storage until proof. An old captured
owner can release only its own mapped coordinates, once; clear cannot reuse a
pending slot. Failed, undemanded or disposed prepared owners close all inputs,
while native holds keep their charges until use ends. Cleanup attempts remain
independent; cleanup errors prevent success acknowledgement.

Table publication prepares a completely admitted CPU candidate and writes a
fresh unbound physical block. It retains candidate bytes and native slots until
success/retirement. Failure or refusal leaves the outgoing material, table
signature, displayed source and resident pins intact. Current plan and residency
revision are checked before acknowledgement. Successful adoption changes the
Atlas/table/fallback material fields in one task, then releases the outgoing
block and CPU table. Multiple replacement Atlases and old resident pins remain
retained until actual incoming adoption/outgoing release. Replacement overlap
settles only after all outgoing native storage has demonstrably disposed.
An actual source change with bound materials also uses this charged incoming
Atlas generation. An unavailable GPU/overlap grant pauses incoming source work
without changing the old material or pins, and retries only on the existing
capacity wake. Incoming coarse coverage does not replace an outgoing detailed
table while the selected detailed image is still loading; publication waits for
the admitted fresh table's actual successful outcome and retirement. Missing
images or a genuinely coarsened selection may still adopt direct coverage.
Native disposal or an opaque texture-factory failure without proof keeps its
GPU charge quarantined and reports the error; it cannot silently grant capacity.
Unknown lifetime may require a host/backend repair; source qualification does
not claim automatic recovery from that failed disposal.

`map.imagery.pageTablePatches` remains the logical maximum number of visible
patches receiving detailed tables. Managed publication requires two physical
blocks per configured logical patch for the outgoing and unbound incoming
version. Texture packing may round the physical block count. All physical table
storage counts in the existing `map.imagery.gpuBudget` before Atlas pages are
planned, and in the same common source-GPU reservation. There is no second
allowance. If storage cannot fit, planning refuses or limits logical tables and
shows the existing allocation/fallback diagnostics. The primary-owned settings
catalogue reason must say: “Maximum visible terrain patches with detailed imagery
page tables. Managed transactional updates reserve two physical blocks per patch
inside the imagery GPU budget, so outgoing tables remain visible until incoming
writes complete.” The GPU budget reason must include “the complete Atlas mip
chain and full transactional page-table texture”; its unit/default/bounds remain
unchanged. `atlas.tableBlocks` diagnoses physical storage;
`binding.blocks` counts actual bound logical tables.

`tests/ownedImageryAtlas.test.ts` and `tests/managedImageryRuntime.test.ts` use the
actual public common broker and actual public Renderer batch/transfer tracker,
with supplied CPU native queue/texture boundaries. They prepare successful
resident acknowledgement, complete multi-page admission, partial mip throws,
stale source/reset/dispose, unknown completion quarantine, capacity/copy refusal,
GPU preallocation admission, fresh table failure, throwing cleanup, actual runtime
binding/attribution preservation and retry cases. Original test assertions are
unchanged. `fixtures/owned-atlas-consumer.mjs` is staged under the existing strict
full-archive closure, runtime/declaration and negative guards.
`fixtures/publicEntries.ts` prepares the actual public host types. These sources
are UNRUN and do not qualify native rendering, color, mip outcomes or performance.

The source-only six-failure renewal retains the primary's failing run and all
interim old-binding, attribution, native quarantine and retry assertions.
The newly authored managed-runtime fixture now records both native bound texture
identities: an incoming Atlas can legitimately use the same table coordinates
as an outgoing Atlas. Its final generation assertion requires both the Atlas
and table textures to change after successful table acknowledgement, rather
than treating coordinate inequality as physical-generation proof. Original
immutable assertions remain untouched. The globe fixture supplies a snapshot
of default ports to wrappers, and its two-owned-camera case explicitly supplies
the floating-origin parent required by the existing preparation-camera branch.
These repairs are UNRUN until the primary's granted verification.

The same required integration renewal adds `CaptureLocation`,
`groundQueryPoint(capture,eastMeters,northMeters)`,
`groundRelativeMarker(queryPoint,surfaceHeightMeters,offsetMeters)` and
`captureRelativeMarker(capture,captureHeightMeters,eastMeters,northMeters,offsetMeters)`
to Engine's existing root/core geographic exports. Their committed formulas and
the original two placement test bodies are retained verbatim. The host samples
displayed ground at the query point before supplying its known ellipsoid height;
these pure functions do not sample, schedule, navigate or invent missing ground.

Rollback omits `managedAtlas` and uses the retained original plain-record loader
and structural legacy device pathway. The bounded retained producer cannot be
used with a void store; its explicit unsupported error remains. No saved IDs,
parameter defaults, dependencies, lockfile, CI policy, original notices or old
fixtures were changed. Primary must package exact Images/Renderer/Engine source
and adopt these ports under the granted checks before declaring actual delivery.
The next source-only renewal supplies optional original worker decode/preparation
transport through [explicit browser/worker ports](browser-terrain-and-worker.md).
The primary still owns the actual host worker entry and current app adoption.
`offThread` is true only while that supplied worker is selected; its admitted
private messages never detach shared encoded/cache views. No new broker or authority is added. Legacy hidden
Texture/updateURL work and other previously documented native-accounting gaps
remain unqualified. Search/VR destinations are untouched.

YOU CANNOT HAVE AI AS A CO-AUTHOR, OR YOUR CONTRIBUTIONS WILL BE REJECTED.
