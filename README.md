# @foss-earth/engine

Source draft of globe coordinates, camera/input, navigation, terrain/maps, layers/POI/sprites/orbit compass and Map/Location/Controls panels, extracted from Earth `90e23b3ee96f53ec5900afc5991a21fffa58649d`. The full `createGlobeRuntime` source borrows renderer/lifecycle/scheduler/profile/Sky and requires explicit host terrain policy; see [runtime adoption](docs/globe-runtime.md). See [public contracts](docs/public-contracts.md), [host adoption and compatibility](docs/adoption.md) and [source status](docs/source-status.md). No checks, emitted declarations, artifact, candidate commit, admission or consumer adoption have been issued for this draft.

The host supplies the renderer, scene, scheduler, settings, clock and feature contributions. Root/core and imagery imports are pure. Browser, Babylon, settings, gamepad, panels and React have explicit optional entries. The pure `./visualization` entry exposes source defaults, point math, migrations and horizon culling; optional layer/sprite/compass/tuner entries require host ports. See the [visualization and bounded-map contracts](docs/visualization-contracts.md). A displayed geometry coordinate height does not establish a physical terrain datum conversion.

The optional [existing Location provider/cache](docs/location-provider.md) preserves its original persisted records, aliases and Interface → search settings with injected IO/cancellation/clock/timers/storage/settings and airport/host contributions. Map/Controls supply their Document to the current UI factory contract. The nine [retained immutable Engine specifications](docs/retained-specifications.md) preserve source prose and proposal limits.

The [React map cache panel](docs/map-cache-presentation.md) borrows the existing Engine cache and host pulse/visibility/clock, shares the named 40-row/two-second policy with the DOM section, and reports actual storage limits. Engine `./map-cache.css` retains original React feature rules while generic cache-section styles remain UI-owned. All new causal cases and installed public fixtures are prepared and unrun.

After a coordinator-granted slot, `npm run check:implementation` retains incremental TypeScript/lint caches and caps tests at 50%. Record every run under `build/`. The separate [installed-consumer harness](docs/installed-consumer.md) requires complete exact archive name/version/hash/size/location closure, sanitizes subprocess IO/temp authority and guards runtime/declaration resolution inside its isolated workspace. Its inputs and checks remain pending. Source preparation does not authorize a check, server, benchmark or native/GPU build.

Every destination must consume the same pinned `foss-earth/ci` attribution component and shared conformance tests, including documentation-only metadata admission. The primary has staged the shared caller at revision `9e046dd482e0229dc7c7b2d71b079d5905664656`, artifact SHA256 `450ede699f55f9b9c78146eadb73de7c6297e56553e7d7f9e5b164786a7beb24`, policy SHA256 `9ca88bf5861685e22e65e5f39fa65b05faaf9c218875fccbecce1b9f2dca5bd3`. The workflow has no path filter. Engine conformance, installation and actual remote admission verification remain pending; a staged caller is not a passing result.


Current source-only renewal: [ordinary frame preparation, async raster handles and independently attempted owned cleanup](docs/async-raster-and-cleanup.md). Existing immutable originals, CI9e scaffold, prior archives and evidence remain preserved. Causal fixtures and public installed consumers are prepared, not executed or adopted.

The source-only [bounded Atlas page producer](docs/bounded-atlas-producer.md) uses the same public Images acquisition/readback broker and returns explicitly held pages. Managed pages require the optional actual owned whole-batch pathway below; legacy void stores are refused before allocation. No current checked artifact/application adoption or original worker fidelity is claimed.

The optional [managed Atlas runtime](docs/owned-atlas-runtime.md) source now
consumes actual Renderer whole-batch admission/completion/retirement with explicit
same-broker GPU, table and copy grants. Transactional tables reserve two physical
blocks per logical patch inside the existing GPU budget. Source and causal/public
fixtures remain UNRUN; actual artifact and current application adoption are pending.

## Project policies

- [Code of conduct](https://github.com/foss-earth/.github/blob/main/CODE_OF_CONDUCT.md)
- [Contributing](https://github.com/foss-earth/.github/blob/main/CONTRIBUTING.md)
- [AGPL-3.0 license](LICENSE)
- [Security](https://github.com/foss-earth/.github/blob/main/SECURITY.md)
