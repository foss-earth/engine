# Google tiles across a reload

`createTilesRuntime.ts` sets up the Google 3D Tiles requests so that a reload can draw models
the browser already downloaded. The browser's HTTP cache does the storing. The engine keeps
no copy of its own, and `GoogleCloudAuthPlugin` still owns the key and the session.

## What Google sends (checked 2026-10-15)

- `root.json`: `Cache-Control: private, max-age=0, must-revalidate`. Every request returns a
  **new session**, which the root's child URLs carry. A conditional request with the
  root's `ETag` gets **304** while the dataset is unchanged.
- Models (`.glb`): `private, max-age=14400, must-revalidate`, about four hours.
- A request with an unknown or expired session gets **400**.

Cached models are keyed by URLs that include the session. A reload can reuse them only if it
keeps the session that issued them.

## What the runtime does

| Request | `cache` | Why |
| --- | --- | --- |
| Root (`GOOGLE_3D_TILES_ROOT_URL`) | `no-cache` | Revalidate it. A 304 keeps the cached root, so the old session and every cached model URL still match. A changed dataset brings a new root. |
| Models and child tilesets | `force-cache` | Use the cached copy first, however stale, and go to the network only on a miss. |
| Session renewal | `reload` | See below. |

With `autoRefreshToken`, the plugin answers a 4xx by renewing the session from the root and
trying again. It sends that renewal with the failed request's options. Under `force-cache`,
or even `no-cache` with its 304, the renewal would get the same expired session back, and
every model not already cached would keep failing. The runtime therefore wraps
`auth.refreshToken` so a renewal always bypasses the cache, and the fresh root replaces the
cached one. After a renewal the session changes, so models cached under the old one are no
longer used.

`optimizedLoadStrategy` (experimental in 3d-tiles-renderer 0.4.24) goes straight to the
detail the view needs, rather than loading every coarse parent first. That lets cached leaf
models draw sooner after a reload. It is compatible with this engine as written:

- It still calls `calculateTileViewError` through `calculateTileViewErrorWithPlugin`, so the
  focus and anchor overrides apply.
- It shows a tile only at `loadingState === LOADED`, which the parse wrapper holds back
  until meshes can draw.
- No tile-splitting plugin is used, and no other tileset shares this renderer's cache or
  queues. The library's warning covers both cases.

## What is and isn't verified

- **Unit tests:** `tests/createTilesRuntime.test.ts` checks the cache mode of each kind of
  request and of a renewal.
- **Live checks:** Google's headers, the new session per root, the 304 and the 400 were
  checked from Node with the real key.
- **Not verified:** a browser warm-cache reload. Cached bytes still have to be parsed and
  uploaded, and browsers differ in how far `force-cache` trusts a `must-revalidate`
  response. Measure on a real page before claiming a reload time.
