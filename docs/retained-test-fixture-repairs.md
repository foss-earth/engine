# Retained Engine test intake and fixture repairs

The primary's complete retained test log reports 53 failures and 594 passes out
of 647 tests, across eight failed files. Its 69,162 bytes have SHA256
`d2e69d24e964548fe85f9c778b48bf4ac0d84256769938ef7855c1bcd59387dc`.
All 330 current intake files and the actual log are retained under this owner's
ignored `build/source-only/2026-10-09T19-32-00Z-retained-behavior-repairs/`.
That directory's `before-manifest.json` has SHA256
`9b7747e14a496fc49ee4189555e6d5064a131e19f487dbe1bb25dc86ae80dcbe`.
This renewal changes composition and fixtures only. No current source imports,
tests, typecheck, lint, syntax checks, install, build, packing, history operations,
browser or native checks ran in the child. Every repaired case is UNRUN.

The 26 globe failures share the omitted `renderer.exposureEV` setting. Exposure
and ambient fill retain their original IDs under the public Sky owner catalogue.
The source globe host registers missing `SKY_PARAMETERS` from
`@foss-earth/sky/settings`; the installed globe fixture registers the same public
catalogue with its other owner catalogues. No Renderer parameter copy or Sky
implementation enters Engine. The installed runtime and declaration fixtures
also name the already implemented public
`@foss-earth/engine/sprites` `hasPickablePointAt` export. Engine's sprites barrel
already exports its actual picking implementation; no new behavior is introduced.

Twenty failures share the owned Atlas fixture's null layout: its prior 8 MiB
budget permits only a 4-by-4 page grid, fewer than the retained planner's required
24 slots. `OWNED_ATLAS_GPU_BUDGET` is now 12 MiB, enough for a 5-by-5 grid plus
the actual physical table blocks. The five newly authored managed-runtime cases
use this same named GPU budget. Their hard admission inequality remains
`estimatedGpuBytes <= gpuBudget`; the assertion's previous independent 8 MiB
literal was inconsistent with this required minimum. Upload bandwidth remains
8 MiB per update. The planner's minimum, resource admission, explicit tiny-budget
refusal tests, and every original immutable assertion remain unchanged.

The bounded-map fixture now admits 24 source-GPU bytes for its two concurrently
held 2-by-1 RGBA mip chains, each exactly 12 bytes. Its overlap limit remains
20 bytes and its original overlap assertion remains 12 bytes: overlap caps a
subset of source-GPU capacity, never capacity in addition to that pool.

The readback cleanup case still requires both original errors in the original
surface-before-bitmap order and zero live charges. Its surface now uses the
actual public `createCanvasRgbaSurface` adapter with supplied CPU canvas ports.
The adapter resets and observes zero backing storage, reporting its actual
retirement, before the independent original post-retirement surface error is
thrown. Added width/height assertions require that observed reset. A foreign
throwing disposer without retirement proof is still conservatively charged;
no close-shaped fake, pre-resolved retirement promise or native hold is invented.

The original fixed-focus orbit assertions are retained, including the positive
view-only control and zero new images/elevation for the loaded around-focus
region. The fixture previously counted CPU turns on a real wall clock without
settling the retained 500 ms coarsen and 1000 ms pin deadlines. The case now uses
the supplied fake performance/timer realm, advances actual host frames at a
50 ms fixture cadence, and requires unchanged loads/uploads/publication/table
writes and empty queues for longer than both named deadlines. A 120-frame bound
fails explicitly after 6 seconds of simulated time if that state cannot settle.
It neither freezes deadlines during an orbit nor changes selection, camera,
focus, renderer demand or hysteresis policy. The setup's original 40-frame
settlement remains the same for all other original cases.

The async-raster metadata fixture now consistently supplies XYZ sources whose
literal template is `{z}/{x}/{y}`, as required by its unchanged metadata
assertion. Its prior first source was a real ArcGIS provider with the distinct
`{z}/{y}/{x}` template. Provider-specific production URL substitution remains
unchanged. All cancellation, replacement, readiness and no-terrain-churn
assertions remain present.

The lighting fixture returns the actual adapter's same `MaterialPlugin`
constructor with a localized named test-call type. The private implementation
already reads scene/engine from its material and takes the original single
argument. Earlier fixture wrappers unnecessarily constructed Mesh/SubMesh
against the retained Mesh mock, and their subclass also changed the original
`instanceof` identity. No dummy meshes or production method signatures are
changed. This supersedes the temporary-mesh fixture adaptation described in the
earlier type-repair record; that record and its before bytes remain retained.

Rollback restores only this renewal's changed files from its before directory,
then restores its before provenance and receipt. Prior root declarations,
lineage, source selection, development prerequisites, locks, assets, history,
notices and pinned shared CI remain intact. The primary must run the exact
failed owner and installed-consumer checks under its heavy grant and retain
their logs before accepting a current artifact. No archive, application adoption
or remote admission claim follows from the source receipt.

YOU CANNOT HAVE AI AS A CO-AUTHOR, OR YOUR CONTRIBUTIONS WILL BE REJECTED.
