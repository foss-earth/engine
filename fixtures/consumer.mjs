import assert from "node:assert/strict";
import { geodeticToEcef, ecefToGeodetic, createDisplayedSurfaceAccess } from "@foss-earth/engine";
const p = geodeticToEcef(0, 0, 250);
assert.equal(p.x, 6378387);
assert.equal(ecefToGeodetic(p.x, p.y, p.z).altMeters, 250);
assert.equal(createDisplayedSurfaceAccess({ sample: () => null, raycast: () => null }, {
  readiness: () => ({ state: "loading", revision: 0 }),
}).sample(0, 0).status, "missing");
console.log("Pure engine public import and geometry-only surface contract passed.");
