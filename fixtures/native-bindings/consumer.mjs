import assert from "node:assert/strict";
import * as core from "@foss-earth/engine";
import * as browser from "@foss-earth/engine/browser";
import * as globe from "@foss-earth/engine/browser-globe";
import * as native from "@foss-earth/engine/babylon";
assert.equal(typeof globalThis.document, "undefined");
assert.equal(typeof globalThis.window, "undefined");
for (const [owner, name] of [[core, "createGlobeOverviewBinding"], [browser, "createBoundedAtlasImageryLoader"],
  [browser, "createAtlasImageryWorkerBridge"], [globe, "createBrowserGlobeBindings"],
  [globe, "loadBrowserGlobeGoogleProviders"], [native, "createManagedImageryAtlasResources"], [native, "createGlobeRuntime"], [native, "NativeMapStartupError"]]) {
  assert.equal(typeof owner[name], "function", name);
}
assert.equal("createBrowserGlobeBindings" in browser, false, "The native entry stays optional.");
console.log("Engine public native entries imported without constructing a browser/device/session.");
