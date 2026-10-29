import { describe, expect, it } from "vitest";
import { createEngineSettings } from "../fixtures/composition/runtimeHost.js";
import { getGoogleApiKeyFromSearchParams, resolveMapRuntimeConfig } from "../src/settings/mapRuntimeConfig.js";

describe("Google tiles URL credentials", () => {
  it.each(["gkey", "key", "googleKey"])("reads and trims %s", name => {
    expect(getGoogleApiKeyFromSearchParams(new URLSearchParams({ [name]: " fixture " }))).toBe("fixture");
  });

  it("prefers gkey even when older aliases appear first", () => {
    expect(getGoogleApiKeyFromSearchParams(new URLSearchParams("key=old&googleKey=older&gkey=current"))).toBe("current");
  });

  it.each(["", "gkey=", "gkey=+", "gkey=&key=old"])("has no credential for %s", query => {
    expect(getGoogleApiKeyFromSearchParams(new URLSearchParams(query))).toBeNull();
  });
});

describe("signed-in Google tiles", () => {
  it("keeps a key from this visit and skips a key only saved on the device", () => {
    const settings = createEngineSettings();
    settings.set("map.source.googleKey", "saved-on-device");
    expect(resolveMapRuntimeConfig({ settings, ignoreSavedGoogleKey: true }).googleApiKey).toBeNull();
    expect(resolveMapRuntimeConfig({ settings, googleApiKey: "this-visit", ignoreSavedGoogleKey: true }).googleApiKey).toBe("this-visit");
    expect(resolveMapRuntimeConfig({ settings }).googleApiKey).toBe("saved-on-device");
  });
});
