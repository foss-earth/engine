# Terrain light uniform writes — 27 October 2026

Uncommitted local work in engine. There is no commit yet.

`bindForSubMesh` in `src/babylon/imagery/terrainLightPlugin.ts` skips
`updateFloat4` and `updateFloatArray` when every component is `Object.is`-equal
to the last write on that same uniform buffer. The last write is a `WeakMap`
entry keyed by the buffer. Float4 components are stored in place; float arrays
are copied, because the local-light arrays are filled in place and the
ground-light table can be updated in place. A new buffer is a different key, so
it writes. A new effect (`_currentEffect`) drops the entry, and the next bind
writes every uniform again. Any changed value still writes, including one
component and signed zero (`Object.is`). `setTexture` is outside the skip and
still runs on every bind that has a night map.

Babylon's `writeBuffer` path stays a separate open candidate (P-092).

## Tests

`tests/terrainLightPlugin.test.ts` has a test for the skip, a changed
component, and a second buffer. The same test also covers a new effect. The
file passed 16 tests. ESLint on the change was clean.

## Timing

A Node timing of 8,000 identical binds against the old always-write loop was
about 1.8× faster, with no overlap:

| Arm | Always-write | Skip |
| --- | ---: | ---: |
| Uniform buffer | 5.22 ms | 2.88 ms |
| Writes forwarded through an effect | 5.20 ms | 2.96 ms |

This is not a frame-rate claim.
