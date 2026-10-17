import { describe, expect, it } from "vitest";
import { NATIVE_PARAMETERS, NATIVE_TIER_ID, nativeTierPreference } from "../src/settings/catalogue/native.js";

describe("native worker tier setting", () => {
  it("is a reload-only separate tab with the existing TypeScript default and all explicit preferences", () => {
    const spec = NATIVE_PARAMETERS.find(parameter => parameter.id === NATIVE_TIER_ID)!;
    expect(spec).toMatchObject({ kind: "choice", default: "typescript", appliesLive: false, home: { tab: "native" } });
    expect(spec.kind === "choice" && spec.choices?.map(choice => choice.id)).toEqual(["auto", "typescript", "single", "threaded"]);
    for (const value of ["auto", "typescript", "single", "threaded"] as const) expect(nativeTierPreference({ get: <T>() => value as T })).toBe(value);
    for (const value of [undefined, null, 0, "wasm"]) expect(() => nativeTierPreference({ get: <T>() => value as T })).toThrow("Native tier must be");
  });
});
