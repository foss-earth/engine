# Reusing a Google session on a return visit: already done — 8 November 2026

Audit item L20 of the performance limits audit (app
`docs/proposals/performance-limits.md`), with its measurement M-7, "a keyed
visitor's second visit". Ledger: P-147.

**Result:** no change needed. The engine has reused the session and the
browser's copies of Google's tiles since engine `551d10e` (15 October). The
audit said nothing reused it; M-7 shows otherwise.

## What the engine does

`src/babylon/createTilesRuntime.ts`, from `551d10e`:

- Models and child tilesets are fetched with `cache: "force-cache"`. Their
  URLs carry the session, so a URL from an earlier visit with the same
  session is answered by the browser's disk cache.
- The root is fetched with `cache: "no-cache"`, so the browser revalidates
  it. Google answers 304 for an unchanged dataset, and the browser keeps the
  cached root, with its session.
- When a session has expired, a request fails with a 4xx, and the renewal
  fetches the root with `cache: "reload"`, so it gets a new session from the
  network.

## M-7

`build/session-reuse/m7.mjs` (not committed): the app's dev server at engine
`d774fb3`, Google 3D tiles, Minneapolis at 60 km, pitched 80°, 20 s a visit.
Two visits in one Chrome profile, with Chrome closed between them, so only
the disk cache carries over. Run twice:

| | Visit 1 | Visit 2 |
| --- | ---: | ---: |
| Google requests | 202 and 201 | 201 and 201 |
| Answered by the disk cache | 0 | 200 and 200 |
| Bytes from the network | 7.86 and 7.85 MB | 23 and 23 bytes |
| Root | 200, 28 KB | revalidated, 23 bytes |
| Session | one | the same as visit 1 |
| Tiles drawn and loaded | 62 and 131 | 62 and 131 |

Every path the second visit asked for was one the first visit had asked for.

## Why not skip the root's revalidation as well

That would save one round trip before the first tile, and one root request.
But Google serves the root with `Cache-Control: private, max-age=0,
must-revalidate`, so the browser has to ask again each time. Models come with
`max-age=14400, must-revalidate` (4 hours).

## Left

Nothing for L20. Its status in the audit is updated in app.
