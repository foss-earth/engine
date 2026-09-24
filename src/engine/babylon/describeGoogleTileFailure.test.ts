import { describe, expect, it } from "vitest";
import { describeGoogleTileFailure, redactTileUrl } from "./describeGoogleTileFailure";

describe("Google tile failure reports", () => {
  it("keeps the key out of the logged url", () => {
    expect(redactTileUrl("https://tile.googleapis.com/v1/3dtiles/root.json?key=secret&session=abc")).toBe(
      "https://tile.googleapis.com/v1/3dtiles/root.json?key=redacted&session=redacted",
    );
  });

  it("includes the http body and says when the browser hid the status", () => {
    const report = describeGoogleTileFailure({
      error: new TypeError("NetworkError when attempting to fetch resource."),
      url: "https://tile.googleapis.com/v1/3dtiles/root.json",
      http: { status: 403, statusText: "Forbidden", contentType: "application/json", body: "{\"error\":{\"message\":\"API key not valid\"}}" },
      resource: { responseStatus: 0, durationMs: 42.2 },
      online: true,
      origin: "http://127.0.0.1:4174",
    });
    expect(report).toContain("TypeError: NetworkError when attempting to fetch resource.");
    expect(report).toContain("http: 403 Forbidden");
    expect(report).toContain("API key not valid");
    expect(report).toContain("resource timing status: hidden (0)");
    expect(report).toContain("page origin: http://127.0.0.1:4174");
    expect(report).not.toContain("navigator.onLine");
  });
});
