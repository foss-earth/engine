// @vitest-environment jsdom
import { expect, it } from "vitest";
import { NativeMapStartupError } from "../src/babylon/nativeMapSettlement.js";
import { createGlobeHostFixture } from "../fixtures/composition/globeHost.js";
it("offers a real terminal map drain from the public globe factory and preserves borrowed device ownership", async () => {
  const h = createGlobeHostFixture(document);
  h.runtime.destroy();
  // Factory returns the richer settlement contract; the legacy fixture annotation
  // intentionally retains its older structural GlobeRuntime port type.
  const owner = h.runtime as typeof h.runtime & { whenSettled(): Promise<void> };
  await owner.whenSettled(); expect(h.scene.isDisposed).toBe(false); h.disposeHost();
});

it("retains a failed hot-switch startup drain while the globe recovers into fallback", async () => {
  let finish!: () => void;
  const parser = new Promise<void>(resolve => { finish = resolve; });
  const h = createGlobeHostFixture(document, defaults => ({
    mapPorts: { ...defaults.mapPorts, google: { ...defaults.mapPorts.google,
      createTilesRenderer() {
        throw new NativeMapStartupError([new Error("Partial startup")], "Partial startup", () => parser);
      },
    } },
  }));
  h.settings.set("map.source.googleKey", "fixture-key");
  h.settings.set("map.source.basemap", "google");
  expect(h.runtime.status.mode).toBe("fallback");
  h.runtime.destroy();
  let settled = false;
  const proof = (h.runtime as typeof h.runtime & { whenSettled(): Promise<void> }).whenSettled().then(() => { settled = true; });
  await Promise.resolve(); expect(settled).toBe(false); expect(h.scene.isDisposed).toBe(false);
  finish(); await proof; expect(settled).toBe(true); h.disposeHost();
});
