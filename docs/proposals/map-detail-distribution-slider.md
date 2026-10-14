# Map detail distribution slider

Status: proposal only; no runtime, styling or loading changes implemented.

Date: 2026-10-14.

Owner: `@foss-earth/engine`. FOSS Earth and 0sfs use the shared control.

Replace the loaded-detail I-beam with a distribution of displayed tiles. Draw
vertical rectangles that extend equally above and below the horizontal detail
axis, giving the appearance of a waveform. The hollow circular handle sets the
requested detail; the distribution shows the detail the renderer has delivered.

This proposal revises the HUD presentation described in the retained
[Map detail control specification](map-detail-control.md). That historical
document remains unchanged. The shared image viewer proposal is separate work.

## Requested design

- Keep the widget's existing dimensions, placement and responsive layouts.
- Keep finer detail on the left and coarser detail on the right.
- Use the current horizontal colormap for the distribution rectangles.
- Make the existing circular handle transparent inside its outline.
- Replace the single I-beam with bars whose heights represent tile counts.
  Mirror every bar across the horizontal axis; the lower half repeats the
  same count, rather than representing negative counts or another dataset.
- Moving the handle continues to request detail through the existing loader.
  The shape responds as the displayed tiles change, including while the
  handle remains still.

Confirmed counting scope: count tiles contributing to the visible map.
Cached tiles outside the view do not contribute to the waveform.

## Verified starting points

| Source | Existing behavior and implication |
| --- | --- |
| [mapDetailSlider.ts](../../src/map/mapDetailSlider.ts) | Native range input writes a session override. A separate I-beam draws `loadedTarget`; the tooltip and accessible value name the scalar measurement. |
| [map.css](../../styles/map.css) | Owns dimensions, gradient, native thumbs, default/host ticks and pending/limited styling. |
| [mapDetailPolicy.ts](../../src/terrain/mapDetailPolicy.ts) | Raster uses binary resolution offset `d`; Google uses screen-space geometric error in pixels. Horizontal position is `-d` or `log2(errorPx)`, respectively. |
| [imageryBinding.ts](../../src/terrain/imagery/imageryBinding.ts) | `measureLoadedImagery` reduces actual bindings to a visible-area-weighted mean of logarithmic sampling density. Source images may occupy multiple atlas pages. |
| [createImageryRuntime.ts](../../src/babylon/imagery/createImageryRuntime.ts) | `refreshLoadedDetail` responds to view, surface, plan and publication changes. Actual material adoption can lag selection and upload. |
| [createTilesRuntime.ts](../../src/babylon/createTilesRuntime.ts) | `observeLoadedError` measures camera-visible tiles before focus/anchor overrides, then reduces their errors to a maximum. Feedback currently fires when that maximum changes. |
| [connectMapDetailRuntime.ts](../../src/map/connectMapDetailRuntime.ts), [mapDetailController.ts](../../src/map/mapDetailController.ts) | Forward and compare scalar delivery state. Distribution changes need their own propagation and equality handling. |

The existing scalar cannot reconstruct a distribution. Two views can have the
same mean or maximum while containing very different tile populations.

## Geometry and appearance

Preserve these current CSS measurements:

| Element | Existing geometry to retain |
| --- | --- |
| Compact control | Width and flex basis 41 px; horizontal margins 4 px |
| Rail | Height 28 px; horizontal centerline at y = 14 px |
| Expanded HUD | Parent width 18 rem, maximum 100%; control stretches as it does today |
| Range input | Top 4 px, height 20 px, left −6 px, width `calc(100% + 12px)` |
| Handle | 12 px outer diameter, 2 px border, existing outline/shadow and focus treatment |

The range's extra width compensates for native thumb travel. Position the bars
against the rail, not the extended input box. Preserve the different WebKit
and Firefox thumb declarations that produce the same outer diameter.

Use at most 18 px of full bar height, centered at y = 14 px: the largest bar
runs from y = 5 to y = 23, matching the current I-beam's vertical extent.
Use a thin centerline inside the existing track area. This changes the drawing
inside the rail without changing any layout box or hit area.

Use the existing stops exactly: green `#46db8f` at 0%, yellow `#f6d365` at
55%, and red `#ff6b6b` at 100%, interpolated along the full horizontal axis.
Apply one shared gradient across all rectangles, rather than restarting the
gradient inside each bar or coloring by height. A small inline SVG with a
shared gradient and reusable rectangle nodes is sufficient; it needs no new
chart dependency or rendering context.

Keep the saved-default tick and host markers, including 0sfs's Flight minimum,
above the bars. Keep the native thumb above those layers. Its fill becomes
transparent, so the bars remain visible through its center. All distribution
graphics ignore pointer events and are hidden from the accessibility tree.

## What the axes mean

The horizontal axis keeps the current selectable range, units, direction and
input steps. Raster offsets and Google geometric-error pixels remain separate
measurements. Raw source zoom or tile-tree depth must not replace them: a
given source LOD can have different apparent detail at different distances,
and would not align with the handle's requested value.

The vertical axis counts distinct displayed tiles in each horizontal bin.
It does not count requests, terrain patches, atlas slots, bytes or screen
pixels. A tile covering a small visible region counts once, just as a tile
covering a large region does. Consequently this is a tile-count distribution,
not a claim about the percentage of the screen at each detail.

### Raster imagery

Count each distinct source image currently sampled by camera-visible published
material bindings once. Identity includes source, version, variant and tile
coordinates. A 512 × 512 image counts as one tile even when represented by
four 256 × 256 atlas pages. Repeated table cells or terrain patches referencing
one image must not multiply its count. An ancestor counts while it still
provides visible fallback, and stops counting when completely replaced.

Reuse the current projected-detail calculation for each contributing region:
`d = log2(normalTargetPx / footprintPx) + boundPageLevel − referenceLevel`.
An image can have different projected detail across its visible portions.
Use the visible-area-weighted mean of those offsets **within that image** as
its representative position, then contribute exactly one count at that
position. Keep this estimate explicit in the tooltip. Do not reuse the old
global mean or use area weights as bar heights.

This requires preserving the source-image identity of published pages and
direct bindings. Follow the material's adopted atlas generation; a reused
slot number is not an image identity. Pending tables, completed downloads
awaiting upload/adoption, cached offscreen pages and focus-only demand do not
enter the count. Use the existing visibility/projection estimates; this does
not claim exact per-pixel occlusion measurement or require GPU readback.

Tie the measurement partition to the adopted display and view. The current
`loadedRegions` calculation can change its region partition when a requested
plan changes, even before different imagery is bound. Reuse the prior snapshot
or a stable display-derived partition in that case: a new request alone must
not change a tile's estimated position through repartitioning artifacts.

### Google 3D tiles

Reuse the per-tile native camera error already captured by `observeLoadedError`.
After traversal, contribute one count for each drawable tile in
`tiles.visibleTiles` whose native camera measurement is in view. Exclude
focus-only tiles, cached invisible tiles and unfinished descendants. Count
the tile once, irrespective of how many meshes it contains. If parent and
child both actually render, each counts.

Keep the native measurement before anchor overrides. Zero and subpixel
errors occupy the finest end consistently with the existing position helper;
retain their raw values for the text summary. Infinite coarse measurements
belong to overflow; invalid measurements remain explicitly unknown.

## Binning and height

Use equal-width bins in the existing horizontal position space. As an initial
visual choice, target roughly 3 CSS px per bar including its gap: 13 bins in
the 41 px compact rail, increasing with the already-supported expanded width
up to 64 bins. Rebin on measured width or selectable-range changes, without
changing the requested target or tile selection. Keep a 1 CSS px gap where
space permits. This resolution is a reviewable starting point, not extra LOD
steps imposed on the renderer.

Each measured tile contributes to exactly one bin. Use consistent half-open
intervals, with the final endpoint included in the last bin. Accumulate
measurements beyond the selectable range into the corresponding edge bar,
recording overflow counts separately. Mark overflow within that bar and
explain it in the tooltip; do not silently claim it has the endpoint's value.
With equal range endpoints, center the equal-value population and retain
separate finer/coarser overflow at the edges; the handle stays disabled.

Use one linear count scale for all bars. Recommended initial scaling:

- Choose a ceiling that is the smallest power of two covering the tallest
  bin, with a minimum of one tile.
- Retain that ceiling for the active source and bin layout; increase it only
  when a count exceeds it. Reset it when the source, domain or bin layout
  changes. Do not rescale downward on every tile arrival or removal.
- For a bin count `n` and ceiling `C`, each half-height is `9 × n / C` px.
  A zero count has zero height. Do not enforce a minimum height that makes
  different small counts appear equal.
- State the count ceiling in the tooltip. A ceiling increase can shorten
  other bars; it is a scale change, not tile removal.

This preserves relative counts and makes population decreases visible while
the scale remains fixed. The tradeoff is that a sparse view can look small
after a dense view. Review this at compact size before considering a separate
rescaling policy; do not add a scale control to this widget.

## Delivery contract and updates

Add a distribution snapshot alongside the existing scalar delivery fields in
the engine's public contracts. Keep `loadedTarget`/`loadedErrorTarget` for
compatibility with existing consumers; the new HUD does not draw them as an
I-beam. Describe the new contract in terms of:

- Source identity/generation and measurement kind, matching the active source.
- An immutable, bounded collection of measured values and integer counts;
  equal values may be combined. Image and GPU handles stay runtime-owned.
- Total contributing tile count, count without a usable measurement, and an
  explicit incomplete-coverage flag.
- A revision or equivalent stable equality mechanism that changes when the
  measured population changes, including when the old mean/maximum does not.

Distinguish unavailable telemetry from a measured empty view. Empty means zero
tiles contribute to the current view. An unavailable snapshot has no bars and
an explanatory description. A partial measurement can show its known counts
while naming the unknown count or incomplete coverage; missing imagery is
never represented as an invented coarse tile.

Classify each identified image once. If any of its visible contributions lacks
a usable projection, count that image as unknown rather than also placing it
in a measured bin or averaging only its measurable portions. Infinite coarse
measurements are valid overflow, not unknown. If image identity itself cannot
be recovered reliably enough to deduplicate, report unavailable telemetry
rather than an invented tile total. Missing bound coverage sets the incomplete
flag without inventing an unknown tile identity.

During a mixed-source material handoff, report the distribution unavailable
until the active source can be reported coherently. This also applies while
all displayed imagery still belongs to the outgoing source. Do not relabel it
or restore an old cached snapshot on returning to a source. Invalidate/filter
delivery by the live runtime generation before the first active-source state
notification; the current bridge activates a source before reporting delivery.
Same-source atlas replacement can continue reporting from adopted bindings
across generations, deduplicated by image identity.

Extend raster feedback and Google detail state, the globe runtime bridge,
`connectMapDetailRuntime`, delivery copying and controller state comparison.
Take immutable snapshots so later array mutation cannot silently change the
controller's state. Adapters without distribution support report unavailable;
they must not synthesize a single bar from the scalar.

Use existing runtime invalidations and scheduling. Raster already measures
view changes at its configured reselection cadence and reacts to publication;
Google already visits its selected visible tiles. Accumulate during those
paths, coalesce presentation to at most once per rendered frame, and reuse
unchanged snapshots and rectangle nodes. Histogram work must stay bounded by
the visible binding/tile population, with no cache-wide scans, second traversal
or independent polling/animation loop. Cancel any queued UI work on destroy.

A drag updates the requested target immediately through `setSessionOverride`.
Only delivery/view measurements update the bars. The existing selector,
hysteresis, loading priorities, source caps and resource constraints determine
when detail arrives or coarsens. A fixed-camera request change alone must not
move the distribution before the displayed bindings change.

Retain pending/limited explanations. Keep any pending pulse confined to the
centerline, respecting reduced motion; bar height does not pulse or simulate
loading. The shape changes only when its measurements or scale change.

## Interaction and accessible text

Preserve the native range input, keyboard steps, pointer/touch dragging,
session/default behavior, focus treatment and both ordinary numeric endpoints.
Loading feedback must not replace the input or move a handle being dragged.

Replace “I-beam” wording with a concise distribution summary, for example:
“Requested: Normal. 37 visible imagery tiles; detail estimated per tile.
5 coarser than the selectable range. Bar scale: 16 tiles. Still loading.”
The value description can summarize the measured extent as well. Keep the
existing active-target and limiting-reason explanations where relevant.
Do not announce every streaming update through a live region or add focusable
bars. The default and host ticks retain their existing text descriptions.

## Implementation sequence and acceptance

1. Add the additive delivery contract and pure aggregation/binning helpers.
   Test counting, projection units and change detection before drawing bars.
2. Collect Google and raster distributions from adopted visible content.
   Extend the runtime/controller bridge, including source transitions.
3. Replace the I-beam layer, make the thumb fill transparent, and update text
   in the shared engine control and stylesheet.
4. Verify the FOSS Earth and 0sfs consumers with their existing composition
   workflows. Update visual evidence after implementation; this proposal does
   not establish runtime or browser qualification.

Required evidence:

| Area | Acceptance condition |
| --- | --- |
| Counting | One fallback image across many cells counts once; one 512 px image across four pages counts once; offscreen cache/focus-only/in-flight work counts zero. Histogram plus unknown counts accounts for every contributing tile. |
| Actual delivery | Held uploads or unadopted tables do not change bars. Replacement, coarsening, eviction and source handoff reflect what is bound. Test managed and legacy atlas paths, table-budget fallback and reused slots. |
| Distribution changes | Two populations with the same old scalar still publish different distributions. Camera/FOV/viewport changes update projected positions. At a fixed view, moving only the request leaves bars in place until adoption. |
| Edge cases | Zero/one/many tiles, partial/unknown measurements, infinities, out-of-range detail, zero/subpixel Google error, equal endpoints, source replacement and disposal remain defined. |
| Geometry and color | Compact 41 × 28 px and existing expanded layout stay unchanged. Bars mirror at y = 14 px; shared gradient stops match the current colors. The 12 px ring reveals the bars. Thumb centers and bin positions align at both endpoints. |
| Input and accessibility | Bars never intercept input. Pointer, touch, keyboard, focus, disabled state and telemetry during dragging work. Default/Flight minimum ticks and limit descriptions remain readable. |
| Performance | Unchanged measurements cause no new feedback or DOM writes; unchanged bins reuse nodes. No new requests, cache pinning, continuous rendering or hidden Map-panel mutation follows from the histogram. |

Extend the existing [imagery binding tests](../../tests/imageryBinding.test.ts),
[imagery runtime tests](../../tests/createImageryRuntime.test.ts),
[Google runtime tests](../../tests/createTilesRuntime.test.ts),
[controller tests](../../tests/mapDetailController.test.ts) and
[bridge tests](../../tests/connectMapDetailRuntime.test.ts). Add focused slider
coverage; retain the [hidden-panel mutation check](../../tests/mapDetailPanel.test.ts).
Use browser measurements/screenshots for real thumb sizing and transparency
across Chromium, Firefox and WebKit, both themes, compact/expanded layouts and
reduced motion. Use deterministic synthetic imagery for correctness and the
supported rendering backends for adoption checks.

Only documentation is changed at proposal time. No selector, loader, runtime,
CSS, package dependency or widget dimension changes are authorized by this
document's existence.
