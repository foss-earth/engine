# Aircraft terrain regions

`GlobeRuntime.prepareTerrainRegion(options)` acquires a temporary map demand.
It does not place an aircraft, change altitude, take the active camera, change
saved focus/detail settings, or suspend physics. Existing `prepareTerrain`
retains its camera/placement behavior for existing consumers.

The region has a WGS84 geographic center with absolute ellipsoid altitude, a
sphere radius, and an optional forward cone with an ECEF direction. Cone
slices are covered conservatively by enclosing spheres; the entire cone is
covered, including points away from its axis. This can fetch some extra ground
outside the exact cone. Aircraft-specific size/momentum policy belongs to the
host. Priority is the sphere followed by cone distance from the aircraft.

Each request supplies minimum and final targets: Google geometric error in
meters and raster elevation zoom. The current coarser-elevation setting is
applied to raster zoom. Google readiness follows the complete intersecting
loaded tile hierarchy, not global queue idleness. Raster readiness checks
complete selected geographic cells and their adopted visible representatives.
A camera looking away therefore cannot make missing regional coverage ready.
A separate narrow vertical center-support column finds ground height at minimum
detail when a provisional absolute spawn is far above the terrain. It is retired
when the center can be sampled, and is never treated as final safe-volume evidence.
A target finer than the map has is not waited for: the finest detail it does
have counts as ready. For Google that is a drawn tile with no finer children;
for raster terrain, elevation at the finest terrain level shown (`map.terrain.maxLevel`,
less `map.terrain.coarserElevation`), or at the elevation source's last level.
A coarse parent is still insufficient evidence where finer tiles exist, and a
tile not yet drawn is always waited for. `unavailable` means the map itself
is unavailable, such as the fallback globe.

The returned lease has `read()`, `update(region)`, `setVisible(visible)`, and
idempotent `release()`. The optional progress callback starts on a subsequent
owner frame. It reports `loading`, `minimum`, `ready`, or `unavailable`,
separate minimum/final flags, local tile counts, current ground height, source
generation and an optional remaining-time estimate. Tile counts describe
regional evidence, not a known byte download total. Estimates use observed
local completion throughput, are cleared when source/region changes, and
become unknown when progress stalls.

Keep the lease after spawning and update its region as the aircraft moves.
Readiness becoming insufficient never pauses an existing flight. Updating a
region invalidates its old readiness immediately. Throttle movement updates
to meaningful displacement or the host's streaming cadence. Release on
cancellation, supersession or disposal; an AbortSignal also releases it.
Temporary continuous rendering is held while waiting and ends at final
readiness or a reported unavailable target. Normal map/host rendering still
updates evidence afterward.

Hosts decide how to present waiting, offer an override, animate their camera,
or request user consent for a relocation. Overriding a wait need not release
the lease: the map can keep preparing the same region during flight.

## Showing a region

`setVisible(true)` shows why a region is waiting, in the world. The first
shown region is drawn (`src/babylon/terrainRegionOverlay.ts`): its sphere as
a faint cyan shell with rings about the local vertical, its cone as rings and
lines from the aircraft, and an amber box around each map tile its final
detail still waits for, the smallest 512. The map surface inside the sphere
and cone is tinted red, deepest where it meets their boundary
(`src/babylon/terrainRegionHighlight.ts`): the ground cutting into the region.
Regions are hidden by default. The overlay's module is fetched when a region
is first shown; nothing in it is pickable or part of the map surface. The
tint's shader code joins the map's materials when a scene first shows a
region, one recompile, and stays: hiding and showing again are uniforms.
Render targets, such as the sky's ground-light probe, draw the map without
the tint, so its red never lights the aircraft.
