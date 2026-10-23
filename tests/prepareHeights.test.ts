import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { GOOGLE_PROVIDER, GoogleUnavailableError, prepareHeightSamples, readGoogleKey, USGS_PROVIDER } from "../scripts/prepare-heights.mjs";
import { createGoogleTilesClient, firstHit, sampleGoogleHeight, segmentIntersectsVolume, trianglesOfGlb, type Vec3 } from "../scripts/heights/google.mjs";
import { ecefToGeodetic, geodeticToEcef } from "../scripts/heights/geodesy.mjs";
import { resolveUsgsHeight } from "../scripts/heights/usgs.mjs";

const POINT = { id: "mall", longitudeDeg: -93.234272, latitudeDeg: 44.9762821 };
const KEY = "test-key-never-in-urls";

/** A binary glTF with one flat triangle around the point at `heightMeters`, stored y-up about a node translation. */
function flatGlb(heightMeters: number, around = POINT, spanDeg = 0.003): Uint8Array {
  const center = geodeticToEcef(around.longitudeDeg, around.latitudeDeg, heightMeters) as Vec3;
  const corners = [[-spanDeg, -spanDeg], [spanDeg, -spanDeg], [0, spanDeg]]
    .map(([dLon, dLat]) => geodeticToEcef(around.longitudeDeg + dLon, around.latitudeDeg + dLat, heightMeters));
  // z-up (x, y, z) is glTF (x, z, -y).
  const toGltf = ([x, y, z]: number[]) => [x, z, -y];
  const translation = toGltf(center);
  const positions = new Float32Array(corners.flatMap(corner => toGltf(corner).map((value, axis) => value - translation[axis])));
  const indices = new Uint16Array([0, 1, 2, 0]);
  const bin = new Uint8Array(positions.byteLength + indices.byteLength);
  bin.set(new Uint8Array(positions.buffer), 0);
  bin.set(new Uint8Array(indices.buffer), positions.byteLength);
  const json = {
    asset: { version: "2.0", copyright: "Test data" }, scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, translation }], meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: "VEC3" },
      { bufferView: 1, componentType: 5123, count: 3, type: "SCALAR" },
    ],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: positions.byteLength }, { buffer: 0, byteOffset: positions.byteLength, byteLength: 6 }],
    buffers: [{ byteLength: bin.byteLength }],
  };
  let text = new TextEncoder().encode(JSON.stringify(json));
  if (text.length % 4) text = new Uint8Array([...text, ...new Array(4 - (text.length % 4)).fill(0x20)]);
  const total = 12 + 8 + text.length + 8 + bin.length;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, total, true);
  view.setUint32(12, text.length, true); view.setUint32(16, 0x4e4f534a, true); out.set(text, 20);
  const binStart = 20 + text.length;
  view.setUint32(binStart, bin.length, true); view.setUint32(binStart + 4, 0x004e4942, true); out.set(bin, binStart + 8);
  return out;
}

/** An axis-aligned ECEF box around the point, `halfMeters` on each axis. */
function boxAround(halfMeters: number, around = POINT): number[] {
  const center = geodeticToEcef(around.longitudeDeg, around.latitudeDeg, 250);
  return [...center, halfMeters, 0, 0, 0, halfMeters, 0, 0, 0, halfMeters];
}

/** A fake Google: a root, an external tileset reached with a session, and named glTF tiles. */
function fakeGoogle(tiles: Record<string, { error: number; glb: Uint8Array; box?: number[] }>, coarse: Uint8Array | null = null) {
  const requests: { url: string; key: string | null }[] = [];
  const leaves = Object.entries(tiles).map(([name, tile]) => ({ boundingVolume: { box: tile.box ?? boxAround(400) }, geometricError: tile.error, content: { uri: `${name}.glb` } }));
  const documents: Record<string, unknown> = {
    "/v1/3dtiles/root.json": { asset: { version: "1.0" }, root: { boundingVolume: { box: boxAround(10_000) }, geometricError: 1e9, refine: "REPLACE",
      ...(coarse ? { content: { uri: "/v1/coarse.glb?session=abc" } } : {}),
      children: [{ boundingVolume: { box: boxAround(5_000) }, geometricError: 64, content: { uri: "/v1/branch.json?session=abc" } }] } },
    "/v1/branch.json": { asset: { version: "1.0" }, root: { boundingVolume: { box: boxAround(5_000) }, geometricError: 64, children: leaves } },
  };
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push({ url: url.href, key: new Headers(init?.headers).get("X-Goog-Api-Key") });
    if (url.pathname !== "/v1/3dtiles/root.json" && url.searchParams.get("session") !== "abc") return new Response("no session", { status: 400 });
    if (documents[url.pathname]) return new Response(JSON.stringify(documents[url.pathname]));
    if (url.pathname === "/v1/coarse.glb" && coarse) return new Response(coarse.slice());
    const name = url.pathname.split("/").pop()!.replace(/\.glb$/, "");
    return tiles[name] ? new Response(tiles[name].glb.slice()) : new Response("missing", { status: 404 });
  }) as typeof fetch;
  return { fetcher, requests };
}

describe("Google build-time heights", () => {
  it("tests a vertical line against oriented boxes and spheres", () => {
    const p0 = geodeticToEcef(POINT.longitudeDeg, POINT.latitudeDeg, -500) as Vec3;
    const p1 = geodeticToEcef(POINT.longitudeDeg, POINT.latitudeDeg, 9000) as Vec3;
    expect(segmentIntersectsVolume({ box: boxAround(50) }, p0, p1)).toBe(true);
    const far = { ...POINT, longitudeDeg: POINT.longitudeDeg + 0.01 };
    expect(segmentIntersectsVolume({ box: boxAround(50, far) }, p0, p1)).toBe(false);
    const flat = boxAround(50); flat.splice(9, 3, 0, 0, 0);
    expect(segmentIntersectsVolume({ box: flat }, p0, p1)).toBe(true);
    expect(segmentIntersectsVolume({ sphere: [...geodeticToEcef(far.longitudeDeg, far.latitudeDeg, 250), 100] }, p0, p1)).toBe(false);
    expect(() => segmentIntersectsVolume({}, p0, p1)).toThrow(GoogleUnavailableError);
  });

  it("converts y-up glTF content to earth-centred coordinates and finds the top surface", async () => {
    const low = await trianglesOfGlb(flatGlb(240));
    const high = await trianglesOfGlb(flatGlb(262.5));
    expect(low.copyright).toBe("Test data");
    const top = geodeticToEcef(POINT.longitudeDeg, POINT.latitudeDeg, 9000) as Vec3;
    const bottom = geodeticToEcef(POINT.longitudeDeg, POINT.latitudeDeg, -500);
    const length = Math.hypot(...bottom.map((value, axis) => value - top[axis]));
    const direction = bottom.map((value, axis) => (value - top[axis]) / length) as Vec3;
    const distance = firstHit([...low.triangles, ...high.triangles], top, direction, length)!;
    const hit = top.map((value, axis) => value + direction[axis] * distance);
    expect(ecefToGeodetic(hit).heightMeters).toBeCloseTo(262.5, 1);
  });

  it("takes the finest tile's surface, not the highest or first, and keeps the key out of URLs", async () => {
    const { fetcher, requests } = fakeGoogle({ fine: { error: 1, glb: flatGlb(236.3) }, medium: { error: 2, glb: flatGlb(250) } }, flatGlb(300));
    const client = createGoogleTilesClient({ apiKey: KEY, fetcher, retries: 1 });
    const sample = await sampleGoogleHeight(client, POINT);
    expect(sample.heightMeters).toBeCloseTo(236.3, 1);
    expect(sample.geometricErrorMeters).toBe(1);
    expect(requests.every(request => request.key === KEY && !request.url.includes(KEY))).toBe(true);
    // The coarse root content is never downloaded once finer geometry answers.
    expect(requests.some(request => request.url.includes("coarse.glb"))).toBe(false);
  });

  it("falls to the next-finest level where the finest tile has no surface on the line", async () => {
    const elsewhere = { ...POINT, longitudeDeg: POINT.longitudeDeg + 0.02 };
    const { fetcher } = fakeGoogle({ fine: { error: 1, glb: flatGlb(236, elsewhere) }, medium: { error: 2, glb: flatGlb(241) } });
    const sample = await sampleGoogleHeight(createGoogleTilesClient({ apiKey: KEY, fetcher, retries: 1 }), POINT);
    expect(sample.heightMeters).toBeCloseTo(241, 1);
    expect(sample.geometricErrorMeters).toBe(2);
  });

  it("refuses coarse-only or missing geometry with a reason", async () => {
    const coarse = fakeGoogle({ only: { error: 16, glb: flatGlb(250) } });
    await expect(sampleGoogleHeight(createGoogleTilesClient({ apiKey: KEY, fetcher: coarse.fetcher, retries: 1 }), POINT))
      .rejects.toMatchObject({ kind: "coarse" });
    const elsewhere = { ...POINT, longitudeDeg: POINT.longitudeDeg + 0.02 };
    const none = fakeGoogle({ only: { error: 1, glb: flatGlb(250, elsewhere) } });
    await expect(sampleGoogleHeight(createGoogleTilesClient({ apiKey: KEY, fetcher: none.fetcher, retries: 1 }), POINT))
      .rejects.toMatchObject({ kind: "no-coverage" });
  });

  it("reports an authorization failure without the key or session in the message", async () => {
    const fetcher = (async () => new Response("denied", { status: 403 })) as unknown as typeof fetch;
    const failure = await sampleGoogleHeight(createGoogleTilesClient({ apiKey: KEY, fetcher, retries: 1 }), POINT).catch(error => error);
    expect(failure).toBeInstanceOf(GoogleUnavailableError);
    expect(failure.kind).toBe("auth");
    expect(failure.message).not.toContain(KEY);
    expect(() => createGoogleTilesClient({ apiKey: "" })).toThrow(GoogleUnavailableError);
  });
});

describe("height preparation", () => {
  const google = async () => ({ heightMeters: 236.30337, geometricErrorMeters: 2.006368, tileDepth: 25, copyright: "Google", requests: 5 });
  const usgs = async () => ({ meters: 235.1, uncertaintyMeters: 6.1, resolutionMeters: 1, description: "USGS test" });
  const now = () => new Date("2026-10-15T12:00:00Z");

  it("uses Google first and records its quality", async () => {
    const result = await prepareHeightSamples([POINT], { google, usgs, now });
    expect(result.points[0]).toMatchObject({
      id: "mall", height: { meters: 236.303, datum: "WGS84-ellipsoid", uncertaintyMeters: 2.01 },
      preparation: { provider: GOOGLE_PROVIDER, sampledOn: "2026-10-15", geometricErrorMeters: 2.006, longitudeDeg: POINT.longitudeDeg },
    });
    expect(result.points[0].height.source).toMatch(/Google Photorealistic 3D Tiles/);
  });

  it("falls back to USGS only when Google is unavailable, and records why", async () => {
    const unavailable = async () => { throw new GoogleUnavailableError("coarse", "only 16 m geometry"); };
    const result = await prepareHeightSamples([POINT], { google: unavailable, usgs, now });
    expect(result.points[0].preparation).toMatchObject({ provider: USGS_PROVIDER, fallbackReason: "coarse: only 16 m geometry", surface: "bare earth" });
    expect(result.points[0].height.source).toMatch(/because Google was unavailable \(coarse: only 16 m geometry\)/);
    await expect(prepareHeightSamples([POINT], { google: unavailable, usgs, fallback: false })).rejects.toThrow(/fallback is off/);
  });

  it("falls back when no key exists, but never on an unexpected error", async () => {
    const result = await prepareHeightSamples([POINT], { googleKey: null, usgs, now });
    expect(result.points[0].preparation.fallbackReason).toMatch(/^no-key/);
    await expect(prepareHeightSamples([POINT], { google: async () => { throw new TypeError("bug"); }, usgs })).rejects.toThrow("bug");
  });

  it("returns all points or none", async () => {
    let calls = 0;
    const flaky = async () => { if (++calls === 2) throw new Error("USGS has no 1 m data"); return usgs(); };
    const unavailable = async () => { throw new GoogleUnavailableError("network", "offline"); };
    const points = [POINT, { ...POINT, id: "b" }, { ...POINT, id: "c" }];
    await expect(prepareHeightSamples(points, { google: unavailable, usgs: flaky, concurrency: 1 })).rejects.toThrow("USGS has no 1 m data");
    await expect(prepareHeightSamples([POINT, POINT], { google, usgs })).rejects.toThrow(/unique id/);
  });
});

describe("USGS fallback datum", () => {
  const geoid = { geoidModel: "GEOID18", units: "m", geoidHeight: -27.5, error: 0.02, lat: POINT.latitudeDeg, lon: POINT.longitudeDeg };
  it("adds GEOID18 to NAVD88 and labels the NAD83-to-WGS84 approximation", () => {
    const height = resolveUsgsHeight(POINT, { value: "262.6", resolution: 1, rasterId: 7 }, geoid);
    expect(height.meters).toBeCloseTo(235.1, 3);
    expect(height.uncertaintyMeters).toBeGreaterThanOrEqual(5);
    expect(height.description).toMatch(/approximate null transformation/);
  });
  it("refuses coarse terrain and a geoid for another point", () => {
    expect(() => resolveUsgsHeight(POINT, { value: 262, resolution: 10 }, geoid)).toThrow(/coarser/);
    expect(() => resolveUsgsHeight(POINT, { value: 262, resolution: 1 }, { ...geoid, lat: 45 })).toThrow(/GEOID18/);
  });
});

describe("Google key discovery", () => {
  let directory: string | null = null;
  afterEach(() => { if (directory) rmSync(directory, { recursive: true, force: true }); directory = null; });
  it("prefers canonical keys while retaining environment and legacy fallback priority", () => {
    const scratch = fileURLToPath(new URL("../build/", import.meta.url));
    mkdirSync(scratch, { recursive: true });
    directory = mkdtempSync(path.join(scratch, "heights-key-"));
    const missing = path.join(directory, "missing.env"), legacy = path.join(directory, "legacy.env"), canonical = path.join(directory, "canonical.env");
    writeFileSync(legacy, "OTHER=nope\nexport FOSS_EARTH_GOOGLE_KEY=\"legacy-file\"\n");
    writeFileSync(canonical, "export GOOGLE_3D_TILES_KEY='canonical-file' # local\nFOSS_EARTH_GOOGLE_KEY=ignored\n");
    const files = [missing, legacy, canonical];
    expect(readGoogleKey({ env: { GOOGLE_3D_TILES_KEY: " canonical-env ", FOSS_EARTH_GOOGLE_KEY: "legacy-env" }, files })).toEqual({ key: "canonical-env", origin: "environment" });
    expect(readGoogleKey({ env: { GOOGLE_3D_TILES_KEY: " ", FOSS_EARTH_GOOGLE_KEY: "legacy-env" }, files })).toEqual({ key: "legacy-env", origin: "environment" });
    expect(readGoogleKey({ env: {}, files })).toEqual({ key: "canonical-file", origin: canonical });
    expect(readGoogleKey({ env: {}, files: [missing, legacy] })).toEqual({ key: "legacy-file", origin: legacy });
    writeFileSync(legacy, "GOOGLE_3D_TILES_KEY=first # local\n");
    expect(readGoogleKey({ env: {}, files })).toEqual({ key: "first", origin: legacy });
    writeFileSync(legacy, "GOOGLE_3D_TILES_KEY= \nFOSS_EARTH_GOOGLE_KEY='legacy-file'\n");
    expect(readGoogleKey({ env: {}, files: [legacy] })).toEqual({ key: "legacy-file", origin: legacy });
    writeFileSync(legacy, "OTHER=not-a-google-key\n");
    expect(readGoogleKey({ env: {}, files: [missing, legacy] })).toEqual({ key: null, origin: null });
  });
});
