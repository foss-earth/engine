import { describe, expect, it } from "vitest";
import { getGoogleApiKeyFromSearchParams } from "../src/settings/mapRuntimeConfig.js";

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
