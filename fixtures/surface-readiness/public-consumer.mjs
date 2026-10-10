import assert from "node:assert/strict";

// Execute only under a separately granted check against the newly emitted
// build, then the fresh exact installed archive. No source/private import.
const browserNames = ["window", "document", "navigator", "WebSocket"];
const originals = new Map(browserNames.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
for (const name of browserNames) Object.defineProperty(globalThis, name, {
  configurable: true, get() { throw new Error(`Core surface import touched browser global ${name}`); },
});
let cases = 0;
try {
  const { createCurrentDisplayedSurface } = await import("@foss-earth/engine/core");
  assert.equal(typeof createCurrentDisplayedSurface, "function"); cases += 1;
  let owner = { revision: 1, sourceGeneration: 1, selectedSource: "raster:synthetic", displayedSources: ["raster"],
    loading: false, paused: false, simulationRunning: null, suspended: false, error: null };
  const resident = new Set([0]); let heightMeters = 100;
  const query = { revision: () => owner.revision, raycast: () => null,
    sample(latDeg) { return resident.has(latDeg) ? { revision: owner.revision, heightMeters, quality: 12,
      point: { x: 6378137 + heightMeters, y: 0, z: 0 }, normal: { x: 1, y: 0, z: 0 }, distanceMeters: 20000 - heightMeters,
      meshId: "synthetic-displayed-triangle" } : null; } };
  const surface = createCurrentDisplayedSurface(query, () => owner);
  const observation = surface.observe({ samples: [{ latDeg: 0, lonDeg: 0 }, { latDeg: 1, lonDeg: 0 }] });
  const events = []; const unsubscribe = observation.subscribe(snapshot => events.push(snapshot));
  assert.equal(observation.read().state, "unavailable"); assert.equal(observation.read().readySamples, 1); cases += 1;
  resident.add(1); owner = { ...owner, revision: 2 }; surface.refresh();
  const ready = observation.read(); assert.equal(ready.state, "ready"); assert.equal(ready.samples[0].height.physicalDatum, "unknown"); cases += 1;
  heightMeters = 250; owner = { ...owner, revision: 3 }; surface.refresh();
  assert.equal(observation.isCurrent(ready), false); assert.equal(observation.read().samples[0].height.meters, 250); cases += 1;
  const beforeSource = observation.read(); owner = { ...owner, sourceGeneration: 2, selectedSource: "raster:imagery-second" }; surface.refresh();
  assert.equal(observation.read().revision, beforeSource.revision); assert.equal(observation.isCurrent(beforeSource), false); cases += 1;
  owner = { ...owner, paused: true, loading: true }; surface.refresh();
  assert.equal(events.at(-1).state, "ready"); assert.equal(events.at(-1).paused, true); cases += 1;
  const retained = observation.read(); surface.dispose();
  assert.equal(events.at(-1).disposed, true); assert.equal(events.at(-1).state, "unavailable"); assert.equal(observation.isCurrent(retained), false); cases += 1;
  const count = events.length; unsubscribe(); unsubscribe(); surface.refresh(); surface.dispose(); assert.equal(events.length, count); cases += 1;
} finally {
  for (const name of browserNames) {
    const descriptor = originals.get(name);
    if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
  }
}
console.log(JSON.stringify({ publicSurfaceConsumer: "passed", cases, browserGlobalsPoisoned: browserNames }));
