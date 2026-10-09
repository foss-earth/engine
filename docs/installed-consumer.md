# Isolated archive consumer prerequisites

`scripts/check-installed-consumer.mjs` is prepared source and has not been invoked for this candidate. Run it only after a coordinator grants the heavy slot and exact current owner artifacts are built and packed. It performs an offline, script-free install into a fresh retained owner workspace and runs public runtime/declaration consumers; it does not accept a sibling source link, old deep import or registry fallback as adoption evidence.

Input is a schema-1 JSON manifest containing a complete flat closure:

```json
{
  "schemaVersion": 1,
  "archives": [
    {
      "name": "@foss-earth/engine",
      "version": "0.1.0",
      "path": "../artifacts/actual-current-engine.tgz",
      "sha256": "<actual 64 lowercase hexadecimal digits>",
      "bytes": "<actual positive safe integer, use a JSON number>"
    }
  ]
}
```

This illustrative object is incomplete and intentionally rejected. Supply the actual canonical regular-file tarball path, byte size, SHA256 and version for every direct and transitive dependency, with one version and one archive per package. Relative paths resolve from the manifest's directory. The harness checks size before reading, then checks actual bytes and digest; it also derives SHA512 for installed-lock integrity comparison. Symlinked archive locations are rejected. No placeholder hash, size, version or source directory qualifies.

The 15 required direct prerequisites must match the current Engine package source exactly:

| Package | Current source version |
| --- | --- |
| `@foss-earth/engine`, `@foss-earth/ui`, `@foss-earth/renderer`, `@foss-earth/images`, `@foss-earth/sky`, `@felipegalind0/gamepad-tools` | 0.1.0 each |
| `@babylonjs/core` | 8.56.2 |
| `3d-tiles-renderer` | 0.4.24 |
| `react`, `react-dom` | 19.2.6 each |
| `typescript` | 5.9.3 |
| `@types/node` | 24.12.4 |
| `@types/react` | 19.2.14 |
| `@types/react-dom` | 19.2.3 |
| `jsdom` | 29.1.1 |

The current installed ancestor versions are not proof of these prerequisites. The exact current UI/renderer/images/Sky candidate archives are mandatory because older frozen artifacts omit source contracts used by this consumer. Include the complete actual closure for jsdom, React/types, 3D Tiles, common images and all package imports; the harness cannot derive or download it under the source lease. Exact transitive archive inputs are still pending. Nested or bundled dependency versions are deliberately rejected; if the actual closure needs multiple versions, revise this harness in an explicit source lease before running rather than suppressing admission.

Outputs and npm cache stay in this Engine owner: `build/consumer/<timestamp>/isolated`, separate `tmp`, `build/npm-cache`, exact input closure and one retained log per command. Owner/output/cache canonical paths may not redirect through symlinks. The child environment removes inherited Node module/options hooks, npm config/package/lifecycle variables and task guard variables; it supplies owner-local TMPDIR/TMP/TEMP, empty separate user/global npm configs, offline/no-scripts/no-audit/no-fund install settings and the explicit workspace guard. It does not delete any previous workspace/evidence or use a global npm cache.

After install, actual lock locations, exact versions, file-archive resolutions and SHA512 integrities must match the supplied closure. Every physically installed package must be an actual in-workspace directory with the expected name/version. An unpinned package, duplicate/nested location, linked checkout, bundle or omitted supplied archive fails admission. Runtime guards follow canonical ESM and CommonJS resolutions; declaration guards inspect the actual strict TypeScript program with `skipLibCheck:false`. All advertised Engine export targets, including CSS, must exist and be nonempty inside the workspace.

Prepared consumers import public entries only. Pure root/provider imports poison host DOM/fetch/frame globals and deny UI/renderer/Sky/Babylon/React runtime imports. Optional consumers retain module/React SSR, visualization/tuner/canvas, bounded maps, borrowed globe runtime and Location cache/provider cases. Explicit negative controls must reject an outside-workspace runtime module, an outside-workspace declaration and a forbidden pure peer import. The Location smoke supplies fake IO/cancellation/timers/storage and sends no real requests. No native/GPU/browser-device/benchmark qualification follows from these CPU cases.

After separate check authorization and actual exact artifacts, the prepared command is:

```sh
node scripts/check-installed-consumer.mjs build/actual-complete-archive-manifest.json
```

No manifest with real complete pins has yet been admitted, and no harness command or negative control has run. Retain its actual receipt/logs; report any failure instead of borrowing ancestor dependencies or claiming source imports as artifact adoption. Common attribution conformance and the complete intended-ref audit are separate required gates, including docs-only metadata changes.

The new owned Atlas installed consumer composes actual public Images broker,
Renderer whole-batch/transfer tracker and Engine Atlas/residency exports. It uses
supplied CPU native texture and completion boundaries to require delayed resident
acknowledgement and exact shared charge retirement. It is staged under the same
complete archive/negative guards and remains UNRUN; no current artifact or GPU
qualification is inferred.

The source-only browser renewal adds `browser-worker-consumer.mjs` under those same archive and isolation guards. It exercises public DEM and worker kernel/service composition with supplied CPU bitmap/message boundaries, without qualifying a real browser decoder, worker realm or GPU.
