# Bounded Atlas page producer — source only

`@foss-earth/engine/browser` now prepares `createBoundedAtlasImageryLoader(options)`, `BoundedAtlasImageryLoaderOptions` and `BrowserImageryLoader`. This is UNRUN source; there is no new checked artifact, installed-consumer result, canonical app adoption, browser decoder/GPU qualification or worker fidelity claim.

The host supplies its one `ImageSessionBroker`, the actual `HeaderInferredImageFileService` created with that same broker, `describe(url,expected)` returning reviewed nonnegative whole `declaredBytes` and optional JPEG/PNG MIME, `priority()` for direct three-argument compatibility calls, `createSurface(width,height)` from its Document/OffscreenCanvas realm, and optional `onBytes(bytes)` for received network chunks. Supplied methods retain their options/service receiver. The URL never determines MIME. Exact reviewed dimensions must be positive whole multiples of the existing 256-pixel page size. The common header path supports JPEG/PNG and identity orientation; other formats/orientations remain unsupported errors, never inferred missing imagery.

The loader borrows the existing common cache, transport and decode queue. It creates no second broker/cache/renderer/clock. Its optional borrowed worker bridge is described in [browser/worker ports](browser-terrain-and-worker.md); without a selected supplied worker, `offThread` is false. `load(url,expected,signal,priority?)` creates a scoped operation; actual residency passes its existing request priority as the optional fourth argument. Legacy loaders may ignore that argument. The pipeline is common `obtainInferred`, common `decode`, common `readbackDecodedImage`, then the unchanged Engine `isBlankImage` and `preparePages`. `createCanvasRgbaSurface` is the public Images helper a browser host may bind to its own canvas factory; Engine never reaches for an ambient Document or constructor.

The common service pre-admits encoded reads/decode/readback and retains nonabortable native input. Engine retains the separate RGBA output through page preparation and reserves the exact page outputs before allocating them: `(width/256)*(height/256)*pageUploadBytes()`. Existing 288/144/72/36/18-square RGBA levels total 441936 bytes per page; their gutters and rounding/box-filter algorithms are unchanged. Bitmap plus RGBA input remain charged separately until the all-attempted post-preparation cleanup. Every fetched/cached response reports its actual encoded byte length as `compressedBytes`; only observed network chunks call `onBytes`. No common/cache body is transferred or detached: common pending cache writes retain that original encoded view plus their independent copy charge until persistence settles.

Only actual `ImageHttpStatusError` 404/204, wholly transparent RGBA, or public `imageDimensionMismatch(error)` final readable-header/native dimension evidence become `ImageryMissingError`. The public classifier walks actual Error causes/AggregateError members with cycle protection; messages and arbitrary status/dimension-shaped objects provide no evidence. Cancellation/generation loss takes precedence over late typed observations, including generation changes triggered by final input cleanup. Common cached mismatch forget/refetch and native decode failure eviction remain unchanged. 429/5xx, malformed/unsupported signatures, MIME/orientation rejection, capacity errors and unrelated native failures use the existing retry/error policy. Operational and cleanup causes remain attached/aggregated; cleanup failure is never success.

`@foss-earth/engine/imagery` now exposes `RetainedPreparedImage` and optional `PreparedImage.close/retain/isCurrent`. The bounded producer implements all three; partial managed contracts are rejected. `retain()` begins native input use and returns an idempotent end function. `close()` requests retirement; pages and their admitted decoded charge remain accessible through existing retained use and retire when it ends. New retain is refused after closing begins. Scope invalidation, parent cancellation and dedicated loader disposal request close without freeing active native inputs early. Explicit final close/detach attempts every owned release. The loader disposes only its scopes; borrowed broker/service/cache/realm survive. A host adopting a dedicated loader supplies the existing explicit `releaseOwnedLoader` runtime port.

Actual residency closes managed answers after stale/source-switch/disposed completion, wrong size, no demand, staged drop, reset, disposal, staging callback failure and upload refusal. It clears prepared fields/reservations/entry identity before cleanup callbacks and attempts all retiring entries on demand drop, reset and disposal. A disposer cannot reopen demand after disposal. Wrong-size legacy missing behavior and wake-after-undemanded-completion behavior are retained. The old unheld records and every original residency assertion remain unchanged.

The subsequent source renewal now supplies an optional actual owned Atlas store,
residency and transactional table pathway through the implemented Renderer
whole-batch capability. See [managed Atlas runtime](owned-atlas-runtime.md) for
public ports, admission, retirement, physical table storage, refusal and retry.
Managed pages still explicitly refuse legacy `store.upload:void` through
`ImageryOwnedUploadUnsupportedError`, before allocation or native work. All new
managed source/checks/artifacts/current adoption remain UNRUN.

`tests/boundedAtlasImageryLoader.test.ts` uses actual public common acquisition/broker/readback with supplied CPU native bitmap/surface boundaries. It prepares cancellation/native lifetime, typed classification, cached mismatch, pending cache writes, exact held output and all-stop cleanup cases. `tests/imageryPreparedLifetime.test.ts` exercises actual residency, original backoff, retirement, partial ownership refusal, throwing callbacks and the actual producer-to-legacy-store refusal. `fixtures/publicEntries.ts` compiles the actual public types; the strict existing installed archive harness stages `fixtures/bounded-atlas-consumer.mjs` under the same full closure/runtime/declaration/negative guards. ALL are UNRUN. No new tests replace or weaken immutable original assertions.

Rollback is omission of this optional browser producer: the unchanged canonical old application and frozen earlier artifacts remain available. No saved record, tab/setting ID, settings catalogue, dependency/lockfile or current application was changed. Legacy MapCache response cloning/native writes, hidden Texture/updateURL decode/upload and actual native worker/managed backend/device restoration qualification remain explicit blockers. Before bytes, original blobs/mappings and source-only receipts are retained in owner `build/source-only/2026-10-09-engine-bounded-atlas`; no history/index/ref edits occurred.

## Outstanding adoption

The actual managed source contract is now implemented as described in
[managed Atlas runtime](owned-atlas-runtime.md). Primary still owns current
package/build/check/app wiring and the restored device adapter. Engine now
contains the reviewed physical-storage catalogue reason and optional worker
bridge/kernel source. Actual host bootstrap and native worker qualification
remain with the primary as described in [browser/worker ports](browser-terrain-and-worker.md). Earlier receipt claims that owned native
upload was wholly unsupported describe that historical interval, not this new
source renewal. Current source is unexecuted; no accepted release is claimed.
