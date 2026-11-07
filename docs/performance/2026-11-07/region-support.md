# A moved terrain region without a one-frame support column — 7 November 2026

P-126 in the performance ledger. Engine `a11e471`; baseline engine
`308616a`. Not an item of the performance limits audit. It came from
counting the raster map's tile records in the 0SFS flight app. **This
changes behavior.** The maps stop asking for tiles they used to drop before
they loaded. It is not bit-identical, and it waits for the owner's
sign-off.

## What it was

A terrain region is the volume around the aircraft that the maps must load
in detail. Fly moves its region every 150 ms in flight
(`flightRegionPreparation.ts`, `lease.update`).

Each move builds a new demand with `createTerrainRegionDemand`, which starts
with `supportRequired: true`. While it is true, the maps also stream a
vertical "support column" over the region's center. That column finds the
ground height under an aircraft whose altitude is not yet known. The
region's next check (`tick`, after the frame) samples the ground at the
center and sets the flag to `supportRequired = ground === null`. In flight,
the ground under the aircraft is known, so the next check turned it off
again.

Between the move and the check, the raster map selected tiles for a demand
with the column. The column's tiles took part of the 256-tile budget, so
leaves all over the globe moved, from level 3 to level 16. The next
selection, after the check, wanted the old tiles back. Every tile created
for the column's selection was dropped before its elevation arrived (the
map's `dropUnneeded`), and created again at the next move:

- Fly's sim tick updated the region and the raster map (`setExternalViewState`)
  and selected set A. One frame later, `prepareFrame` selected set B, after
  the check. 73 of 256 leaves differed, and each selection dropped the other's
  64 unloaded tiles.
- Each drop cancelled the tile's elevation claim and imagery patch, and
  withdrew its elevation request from the terrain loader. No network
  request was cancelled (see Requests). The drop made the tile's Error, a
  detach of the patch and a rebuild of the imagery residency's pins.
- Of the dropped keys, 98 % were created again.

Google mode reads the same flag (`terrainRegionSupportPriority`), so its
tile renderer also asked for the column for one frame after each move.

## What changed

`src/surface/terrainRegionController.ts`: when a lease moves its region, the
new demand's `supportRequired` is what the next check would set, the
center's ground height being unknown. A region moved to where the ground is
not known yet still asks for the column at once. A new lease still starts
with the column, as before.

## Why it is right

The check's rule is unchanged: the column is needed exactly while the
center's ground height is unknown (`supportRequired = ground === null`).
The change applies that rule when the region moves, rather than starting
from "required" and waiting up to one frame for the check.

- Where the ground is known, the old demand asked for the column for one
  update and then dropped it. None of the column's tiles could load in that
  time. The change skips that one update.
- Where the ground is not known, both versions ask for the column at once,
  and both keep it until the ground is found.
- The region's progress, coverage and outlines are still measured at the
  next check, as before.

What can differ:

- **Tiles requested.** The column's tiles, and the leaves its selection moved
  elsewhere, are no longer created. The network traffic did not change
  beyond run-to-run variation (see Requests).
- **Frames.** For the frame between a move and its check, the old selection
  could show other tiles. That was not checked frame by frame. The
  screenshots below are the same.
- **Loading.** The view's tiles are no longer dropped at every other
  selection. Whether they load sooner was not measured.

## Proof

- **`tests/terrainRegions.test.ts`**: a new test. A region moved over known
  ground has no column before the next check, and the check agrees. A region
  moved where the ground is unknown has the column at once, until the ground
  is found. It fails on HEAD.
- **Mutants** (`build/churn/mutants.py`): 6 of 6 caught.
  - HEAD (no line);
  - the comparison inverted;
  - always false;
  - always true;
  - the lease's first center instead of the moved one;
  - the latitude read twice.
- The engine's suite passes (141 files, 1,524 tests), and so does fly's
  `flightRegionPreparation.test.ts` (10). The engine's and fly's
  `npm run typecheck` pass.
- **Screenshots** of fly 15 s and 25 s after content, before and after
  (`research/build/churn/shots/`). Same place, imagery and detail. Fly's
  flight is not deterministic, so they are not compared pixel by pixel.

## Measured

Chrome on the M5, with fly at `2287de0` and engine `308616a`, built twice:
once with this file at HEAD and once with the change. Both builds carried
the uncommitted work in the checkouts. The runs were headless on Metal, from
the default start, in flight. Each stretch was 10 s, starting 15 s after
content, as `profile.mjs` times them.

**Tile records**: counted by a temporary copy of the raster runtime with
counters, built into fly the same way. Interleaved before, after, after,
before. Per second:

| Run | Created | Dropped before loading | Evicted | Selections that dropped |
| --- | ---: | ---: | ---: | ---: |
| before 1 | 755.9 | 747.3 | 7.8 | 18.9 |
| after 1 | 11.6 | 5.9 | 6.1 | 12.5 |
| after 2 | 11.2 | 5.1 | 6.5 | 12.6 |
| before 2 | 729.1 | 720.1 | 8.2 | 18.9 |

In an earlier run of the "before" build, 98 % of the dropped keys were
created again later in the run.

**Requests**, from Chrome's network events over the same 10 s stretch
(`research/build/tools/net-run.mjs`, the clean builds, interleaved before,
after, after, before). Each build kept its Chrome profile, so its second run
had a warm HTTP cache:

| Run | Elevation (`s3.amazonaws.com`): requests, KiB | Imagery (`basemap.nationalmap.gov`): requests, KiB | Cancelled |
| --- | ---: | ---: | ---: |
| before, cold | 256, 19,602 | 79, 774 | 0 |
| after, cold | 314, 19,534 | 81, 847 | 0 |
| after, warm | 112, 3,715 | 44, 426 | 0 |
| before, warm | 138, 3,684 | 53, 442 | 0 |

Neither build cancelled a request. The bytes are the same within 1 % for
elevation and 10 % for imagery, and the request counts move both ways.
So the drops cost CPU and memory, not network. An earlier count from
resource timing (234 before, 321 after, one stretch each) was within this
variation.

**CPU** (`profile.mjs`, CPU profiler on, the clean builds, interleaved
before, after, after, before). Self time in ms/s:

| | before 1 | before 2 | after 1 | after 2 |
| --- | ---: | ---: | ---: | ---: |
| Main thread, % of a core | 33 | 34 | 26 | 27 |
| Script, % of a core | 26 | 26 | 20 | 20 |
| Frame rate | 59.0 | 58.9 | 59.1 | 59.1 |
| JS heap at the end, MiB | 164 | 227 | 87 | 70 |
| `writeBuffer` | 16.8 | 18.0 | 8.0 | 7.4 |
| `createBuffer` | 2.1 | 2.2 | 0.0 | 0.0 |
| Tile meshes: `terrainSurface`, `sampleTerrainGridRow`, `extractMinAndMax` | 14.1 | 15.5 | 0.0 | 0.0 |
| Imagery patches: `detachPatch`, `syncManagedPins` | 6.7 | 7.6 | 0.0 | 0.0 |
| Terrain loader (file) | 10.9 | 11.5 | 2.9 | 3.6 |
| Raster runtime (file) | 19.5 | 20.0 | 13.7 | 13.5 |
| Garbage collector | 11.7 | 11.5 | 9.1 | 10.7 |

A 0.0 is a function below the profile's table, which ends at about
1 ms/s.

About 70 ms/s of main thread went away. Fly already held 59 fps on the M5,
so the gain is headroom and memory, not frames. `writeBuffer` is the
measure M-5 counts: half of it was uploads for tiles that were then
dropped. Nothing was measured on a phone. A phone pays the same churn on a
slower core.

Profiles: `research/build/benchmarks/startup-audit/profile-fly-rs-*/`.
Builds: `0sfs/fly/build/region-support/`, and `churn-*` for the counted
ones. Counters, their output (`counts.txt`), mutants and the controllers:
`build/churn/`.

## Left

- A new lease still starts with the column, and its first check turns it off
  where the ground is known. That happens once per lease, not on every
  move, so it is left as it was.
- `detachPatch` builds an `Error` for every detached patch, even one with no
  pending table, where it goes unused (about 2 µs each). With the churn gone
  it costs little.
- Each surface sample `syncManagedPins` makes still walks every patch. It now
  runs a few times a second, not hundreds.
