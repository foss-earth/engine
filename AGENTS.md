# Agent instructions

Follow the shared rules for every foss-earth repository in
[foss-earth/.github/AGENTS.md](https://github.com/foss-earth/.github/blob/main/AGENTS.md)
(in a local checkout of the organization: `../.github/AGENTS.md`).

## TypeScript and WebAssembly twins

`raster-TS/`, `terrain-TS/` and `ground-TS/` hold the TypeScript reference
cores. `raster-WASM/`, `terrain-WASM/` and `ground-WASM/` hold their Rust twins:
each is a Cargo workspace with its JavaScript wrapper, checked-in binary and
build receipt. New cores use Rust. Keep the TypeScript reference. Accept a
WebAssembly result only after exact functional parity (`npm run check:parity`),
and report the requested and actual backend and every fallback. Do not claim
speed or power improvements from a successful conversion or correctness test.
No fast math or reduced precision to make a benchmark pass. Rebuild a core with
its folder's `scripts/build.mjs`, which uses installed tools offline and keeps
intermediates under `build/`; never install a toolchain without the user's
authorization.
