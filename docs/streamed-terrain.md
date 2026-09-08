# Streamed terrain and visible-surface queries

Raster basemaps now use Mapterhorn Terrarium tiles by default. Imagery and terrain
are loaded independently. Once imagery is ready, its mesh uses a bundled coarse
global Mapterhorn grid, then refines through streamed coarse and detailed data.
The old Gaussian elevation approximation no longer shapes raster geometry.

## Data and rendering

- Endpoint: https://tiles.mapterhorn.com/{z}/{x}/{y}.webp
- Attribution: https://mapterhorn.com/attribution/
- Sources/coverage: https://mapterhorn.com/
- Decoding preserves RGB values: `R * 256 + G + B / 256 - 32768` meters.
- Six concurrent terrain downloads, shared requests, bounded decoded-data cache.
- HTTP 404 falls back through ancestor tiles. Other errors remain errors; they
  do not become zero-elevation ground. Failed map tiles have a 30-second cooldown.
- Neighboring height pixels are sampled across tile boundaries to avoid
  independent edge clamping. Neighbor grids are loaded before applying detail.
- The bundled fallback averages the global zoom-zero tile into a 64×64 grid.
  Failed terrain requests retain the best available geometry.
- Refinement morphs the actual visible vertices over 1.2 seconds. New children
  inherit their parent's triangle surface before morphing. Shared edges follow
  the coarser neighbor, with an interior blend and consistent corner ownership.
- Simulation views retain nearby detail and prefetch a forward corridor. Parent
  meshes remain visible until their children provide complete, equal-or-better
  coverage. Visible geometry changes advance a surface revision counter.
- Nearby meshes use 128 subdivisions per imagery tile; distant meshes use at
  least 64. Source requests are currently capped at zoom 15. Mesh spacing and
  source resolution are distinct: this does not claim to retain all 1 m data.
- Positions are stored relative to each tile center, avoiding float32 loss from
  storing Earth-sized ECEF coordinates in every vertex.

Terrain values currently enter the globe's geodetic height coordinate directly.
There is no geoid/datum correction. Therefore `SurfaceHit.heightMeters` describes
the displayed mesh's WGS84-coordinate height, not a survey-certified elevation.
Mixed-resolution LOD boundaries and source quality still warrant visual review.

## Public API

`createBabylonRuntime` accepts an optional `terrainSource` with `urlTemplate`,
`maxZoom`, and an attribution URL. The source must provide Terrarium-encoded
square images with CORS enabled. Existing `getSurfaceHeightMeters` overrides
still work and bypass the streamed source.

```ts
const hit = runtime.surface.sample(latitudeDegrees, longitudeDegrees);
const obstacle = runtime.surface.raycast(ecefOrigin, ecefDirection, distanceMeters);
```

Both queries intersect currently visible map triangles, excluding aircraft and
other application meshes. Inputs and results remain ECEF even under a simulation
floating origin. Results include the point, geometric face normal, distance,
displayed height, mesh ID, surface `revision`, and terrain zoom `quality` (or -1
when unavailable). A miss returns `null`; the query never invents geometry.
The coarse fallback is queryable because it is itself displayed geometry.
`sample` casts down from 20 km along the geodetic normal; `raycast`
supports arbitrary directions, including building walls and bridge undersides.

Google queries use loaded Google mesh geometry. This API does not export or
persist a dataset derived from Google tiles. Google content remains governed by
the provider's terms.

The terrain loader and types are also exported from `foss-earth/runtime` for
consumers that need direct tile loading. Globe orbit-target heights now query the
visible mesh instead of caching the old approximation.

## Flight-sim integration and remaining work

In raster mode, before each physics substep, flight-sim samples the displayed mesh
at the aircraft position and updates JSBSim's terrain elevation. Missing geometry
blocks integration without accumulating catch-up time. On a surface revision,
the previous aircraft coordinate is sampled again to distinguish terrain moving
from the aircraft flying into an existing hill. Refinement that rises through the
aircraft repositions it above the surface, resets contact/integrator history,
and preserves heading and horizontal velocity. Grounded aircraft also follow
downward refinement; airborne aircraft do not.

Teleports discard stale terrain before initializing physics and use destination
terrain when available. The fixed-step loop rejects nonfinite or implausible
states, restores its last valid snapshot and latches a fault that pauses flight.
An explicit location reset clears that fault.

This feeds the existing JSBSim terrain-contact model. It is not yet a complete
aircraft-versus-triangle contact solver: per-wheel slope normals, swept wing/body
contacts, lateral impacts and consistent response to Google buildings still need
that integration. Rendering and queries share triangles; JSBSim currently consumes
a scalar local support height. Google contact handling remains unchanged; the
general invalid-state guard also protects that mode.

## Live source checks (2026-09-07)

Direct downloads decoded as 512×512 RGB WebP tiles:

| Location | Coordinate | Zoom | Sample height | Tile range |
|---|---|---:|---:|---:|
| LAX | 33.9425, -118.4081 | 15 | 32.63 m | 29.64–39.42 m |
| MSP | 44.8848, -93.2223 | 15 | 251.90 m | 245.66–255.11 m |
| Mount Rainier | 46.8523, -121.7603 | 12 | 4384.81 m | 1452.19–4391.56 m |

Rainier's zoom-15 tile returned 404; its zoom-12 tile succeeded. LAX and MSP also
loaded at zoom 12 and agreed within a meter with these point samples. Downloads
were about 90–276 KB per tile. Response headers included browser CORS access.
These are availability and plausibility checks, not independent accuracy surveys.

Automated tests cover decoding, interpolation, shared borders, concurrent ancestor
fallback, failures, visible-only intersections, lateral rays, floating origins,
rendered terrain height, refinement seams, and the actual JSBSim terrain-elevation
property. Real-SDK regression tests cover upward/downward refinement, genuine
hill encounters, stale terrain after teleport, and fault recovery. The completed
suites contain 179 foss-earth tests and 66 flight-sim tests. In-app flight testing
is being handled by the user; visual behavior has not been verified by the agent.
