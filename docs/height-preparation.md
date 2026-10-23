# Build-time height preparation

`@foss-earth/engine/prepare-heights` and the `foss-earth-prepare-heights` command give a
point a fixed height in metres above the WGS84 ellipsoid, once, at build time. A scene stores
it as `capture.height` and places the orb `capture-relative`, so the viewer never samples the
map for that orb and map detail arriving later never moves it. They run in Node only and are
never part of a browser bundle.

```sh
GOOGLE_3D_TILES_KEY=… foss-earth-prepare-heights --input points.json --output heights.json --cache build/elevation-cache
```

`points.json` is a list of `{ id, longitudeDeg, latitudeDeg }`. Every point gets a height or
the call fails and writes nothing. The UMN-VR tour wraps this as `npm run prepare:heights`
([tools/twin-cities/README.md](https://github.com/UMN-VR/tour/blob/main/tools/twin-cities/README.md)).

## Google first

The source is Google Photorealistic 3D Tiles (`scripts/heights/google.mjs`):

- **Key.** `readGoogleKey` takes `GOOGLE_3D_TILES_KEY` from the environment, with
  `FOSS_EARTH_GOOGLE_KEY` as a legacy fallback. If neither is set there, it checks
  named `.env.local` files in order for the new name, then the legacy name. A new-name
  file value beats a legacy value in another file; either environment name beats files.
  It reads no other variables. The key goes in the
  `X-Goog-Api-Key` header, never in a URL; URLs in messages have their `key` and `session`
  removed.
- **Traversal.** From `v1/3dtiles/root.json`, it follows every tile whose bounding volume
  (box with 1 m tolerance, or sphere) meets the vertical segment from −500 m to 9000 m
  above the ellipsoid through the point, including external tilesets. The session in the
  root's child URLs is kept for the children.
- **Geometry.** Leaf content is Draco-compressed binary glTF. It is decoded with Babylon's
  Draco decoder loaded in Node, turned from glTF's y-up into the tile's z-up frame,
  transformed to earth-centred coordinates, and intersected with the segment.
- **Choice.** It picks the finest level (smallest geometric error) that has a hit, then
  the highest hit in that level. That level wins even when a coarser level reaches higher,
  so a coarse tile's bulge never becomes the height. Google's coordinates are already
  WGS84, so there is no datum conversion.
- **Limits.** Nothing finer than 4 m (`--max-geometric-error`) is `coarse`. A segment
  without a hit is `no-coverage`. Each point is allowed 400 requests, and the client runs
  6 requests at a time, each with a 30 s timeout and 3 tries.
- **Record.** The height is rounded to the millimetre. Its uncertainty is the leaf's
  geometric error, rounded up to the centimetre. `preparation` records the provider
  (`google-photorealistic-3d-tiles`), date, coordinate, geometric error and tile depth.

Nothing from Google is written to disk; the JSON and tile caches live in memory for one run.
Only the derived height is kept. Check Google's Map Tiles API policies before storing more.

## USGS only when Google can't serve a point

`GoogleUnavailableError` (kinds `no-key`, `auth`, `http`, `network`, `budget`, `format`,
`coarse`, `no-coverage`) is the only thing that falls back. Any other error stops the run.
The fallback (`scripts/heights/usgs.mjs`) is USGS 3DEP EPQS bare-earth terrain at 1 m or
finer, plus NOAA GEOID18:

- NAVD88 plus GEOID18 gives the NAD83(2011) ellipsoid. That is taken as WGS84 by a null
  transformation, which is approximate and carries a 5 m allowance.
- The uncertainty is 5 m plus GEOID18's error plus the raster resolution.
- The provider is `usgs-3dep-epqs-geoid18`, and `fallbackReason` says why Google wasn't used.
- Raw public responses are cached under `--cache` for offline rebuilds.

`fallback: false` (`--no-fallback`) fails instead.

## What a height means

It is the top of the surface on the vertical through the recorded coordinate: the ground on
open land, or a roof where the coordinate falls on a building. It is not a measured camera
height. For photographs whose positions are approximate, that difference can be tens of
metres, and the fix is a better position or a height set in an editor.

The first real run, on 2026-10-16, prepared the UMN-VR tour's 60 photographs:

- All 60 heights came from Google, with no fallbacks. Every one came from leaf tiles at
  depth 25 with a 2.006 m geometric error.
- On open ground they agreed with USGS bare earth to about 1 m (Taylor Center 0.02 m). This
  checks the datum handling and the geometry pipeline.
- Coordinates on buildings came out 15–31 m higher, matching roofs. The earlier runtime
  Google sampling showed the same.

## Tests

`tests/prepareHeights.test.ts` uses synthetic tilesets and glTF served by a fake fetcher.

- **Choosing a height:** source precedence, finest-not-highest selection, falling back to
  the next finest level, and coarse or missing coverage.
- **Key and fallback:** the key kept out of URLs and messages, recorded fallback reasons,
  and key discovery.
- **Failure and datum:** all-or-nothing failure, and the USGS datum arithmetic.
