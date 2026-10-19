import { describe, expect, it, vi } from "vitest";
import { createTerrainImageDecoder, type TerrainImageDecodeLimits } from "../src/browser/terrainImageDecoder.js";
import { installTerrainDecodeWorkerKernel, type TerrainDecodeWorkerKernelPorts } from "../src/browser/terrainDecodeWorkerKernel.js";
import { createTerrainDecodeWorkers, type TerrainDecodeWorkersOptions } from "../src/browser/terrainDecodeWorkers.js";
import type { TerrainDecodeWorkerPort, TerrainDecodeWorkerReply, TerrainDecodeWorkerRequest } from "../src/browser/terrainDecodeWorkerProtocol.js";
import { createTerrainNativeDecoder } from "../src/browser/terrainNativeDecoder.js";
import { decodeTerrarium } from "../src/terrain/terrainGrid.js";

/** Fake native image realm: each Blob stands for a tile whose RGBA pixels are known. */
function imageRealm(tiles: Map<Blob, { width: number; height: number; rgba: Uint8ClampedArray }>) {
  const closes = vi.fn(), clears: number[][] = [];
  let contextAvailable = true, readbackShift = 0;
  const createImageBitmap = vi.fn(async (blob: Blob) => {
    const tile = tiles.get(blob); if (!tile) throw new Error("The source image could not be decoded.");
    return { width: tile.width, height: tile.height, close: closes, rgba: tile.rgba } as unknown as ImageBitmap;
  });
  const createCanvas = vi.fn((width: number, height: number) => {
    // Like the worst browser: assigning the same size does not clear. Drawing is
    // source-over, so a transparent source pixel keeps what is beneath it.
    const drawn = new Uint8ClampedArray(1024 * 4);
    const context = {
      clearRect: (...area: number[]) => { clears.push(area); drawn.fill(0); },
      drawImage: (bitmap: ImageBitmap & { rgba: Uint8ClampedArray }) => {
        for (let index = 0; index < bitmap.rgba.length; index += 4) if (bitmap.rgba[index + 3]) drawn.set(bitmap.rgba.subarray(index, index + 4), index);
      },
      getImageData: (_x: number, _y: number, w: number, h: number) => {
        const data = drawn.slice(0, w * h * 4); data[0] = (data[0] + readbackShift) % 256; return { data };
      },
    };
    return { width, height, getContext: () => contextAvailable ? context : null } as unknown as OffscreenCanvas;
  });
  return { createImageBitmap, createCanvas, closes, clears, withoutContext() { contextAvailable = false; },
    /** Another color path: the first red byte reads back one higher. */
    readsOtherBytes() { readbackShift = 1; } };
}
function tile(size: number, pixel: (index: number) => [number, number, number, number]) {
  const rgba = new Uint8ClampedArray(size * size * 4);
  for (let index = 0; index < size * size; index++) rgba.set(pixel(index), index * 4);
  return { width: size, height: size, rgba };
}
const LIMITS: TerrainImageDecodeLimits = { maxTileSide: 1024 };

/** The real kernel behind a fake worker that delivers messages asynchronously. */
function fixture(options: { kernel?: Partial<TerrainDecodeWorkerKernelPorts>; bridge?: Partial<TerrainDecodeWorkersOptions>; limits?: () => TerrainImageDecodeLimits } = {}) {
  const tiles = new Map<Blob, { width: number; height: number; rgba: Uint8ClampedArray }>();
  const worker = imageRealm(tiles), page = imageRealm(tiles);
  const requests: TerrainDecodeWorkerRequest[] = [], transfers: Transferable[][] = [], ports: TerrainDecodeWorkerPort[] = [];
  const kernelErrors = vi.fn();
  const createWorker = vi.fn((): TerrainDecodeWorkerPort => {
    const scope = { onmessage: null as ((event: MessageEvent<TerrainDecodeWorkerRequest>) => void) | null,
      postMessage(reply: TerrainDecodeWorkerReply, transfer?: Transferable[]) { transfers.push(transfer ?? []); queueMicrotask(() => port.onmessage?.({ data: reply } as MessageEvent<TerrainDecodeWorkerReply>)); } };
    const port: TerrainDecodeWorkerPort = { onmessage: null, onerror: null,
      postMessage(request) { requests.push(request); queueMicrotask(() => scope.onmessage?.({ data: request } as MessageEvent<TerrainDecodeWorkerRequest>)); },
      terminate: vi.fn(() => { kernel.dispose(); }) };
    const kernel = installTerrainDecodeWorkerKernel({ scope, createImageBitmap: worker.createImageBitmap, createCanvas: worker.createCanvas, onError: kernelErrors, ...options.kernel });
    ports.push(port);
    return port;
  });
  const limits = options.limits ?? (() => LIMITS);
  const onPage = vi.fn(createTerrainImageDecoder({ createImageBitmap: page.createImageBitmap, createCanvas: page.createCanvas, nowMs: () => 0, limits }));
  const reference = createTerrainImageDecoder({ createImageBitmap: page.createImageBitmap, createCanvas: page.createCanvas, nowMs: () => 0, limits });
  const timers = new Set<() => void>(), onError = vi.fn();
  let size = 4;
  const workers = createTerrainDecodeWorkers({ createWorker, workers: () => size, nowMs: () => 0, idleMs: 30_000, limits, onError,
    timers: { setTimeout: callback => { timers.add(callback); return callback; }, clearTimeout: handle => { timers.delete(handle as () => void); } },
    ...options.bridge });
  const add = (value: ReturnType<typeof tile>) => { const blob = new Blob([`tile ${tiles.size}`], { type: "image/webp" }); tiles.set(blob, value); return blob; };
  return { workers, worker, page, requests, transfers, ports, createWorker, onPage, reference, onError, kernelErrors, add,
    setSize(next: number) { size = next; } };
}
const sameFloats = (actual: Float32Array, expected: Float32Array) =>
  actual.length === expected.length && actual.every((value, index) => Object.is(value, expected[index]));
async function failure(decoding: Promise<unknown>): Promise<Error> {
  try { await decoding; } catch (error) { return error as Error; }
  throw new Error("The tile decoded.");
}

describe("terrain decode workers", () => {
  it("retains page-vs-worker parity and reports native admission/fallback for the individual worker", async () => {
    const native = vi.fn(decodeTerrarium);
    const backend = createTerrainNativeDecoder({ workerId: "worker-test", requestedTier: "single", start: async () => ({ decodeTerrarium: native }),
      timers: { setTimeout: (callback, ms) => setTimeout(callback, ms), clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>) } });
    const f = fixture({ kernel: { decodeTerrarium: backend.decode, decodeBackendStatus: backend.status } }); f.setSize(1);
    const blob = f.add(tile(2, index => [index, 2, 3, 255]));
    for (let index = 0; index < 2; index++) expect(await f.workers.decode(blob, f.onPage)).toEqual(await f.reference(blob));
    expect(f.onPage).toHaveBeenCalledOnce();
    expect(f.workers.stats()).toMatchObject({ parity: "same", nativeWorkers: [{ workerId: "worker-test", actualTier: "single", nativeDecodes: 1, typescriptDecodes: 1 }] });
    native.mockImplementationOnce(() => { throw new Error("native trap"); });
    expect(await f.workers.decode(blob, f.onPage)).toEqual(await f.reference(blob));
    const stats = f.workers.stats();
    expect(stats.nativeWorkers).toMatchObject([{ actualTier: "typescript", fallbackReason: "decode-failed" }]);
    stats.nativeWorkers[0].actualTier = "single";
    expect(f.workers.stats().nativeWorkers[0].actualTier).toBe("typescript");
    expect(f.onPage).toHaveBeenCalledOnce(); expect(f.onError).not.toHaveBeenCalled(); f.workers.dispose();
  });
  it("return the page decoder's exact heights, transfer them, and reuse one cleared canvas per worker", async () => {
    const f = fixture(); f.setSize(1);
    const blobs = [f.add(tile(4, index => [index * 37 % 256, index * 91 % 256, index * 53 % 256, 255])),
      f.add(tile(4, () => [127, 255, 128, 255])), f.add(tile(2, () => [0, 0, 0, 255])), f.add(tile(2, () => [255, 255, 255, 255]))];
    for (const blob of blobs) {
      const decoded = await f.workers.decode(blob, f.onPage), expected = await f.reference(blob);
      expect(decoded.size).toBe(expected.size); expect(sameFloats(decoded.heights, expected.heights)).toBe(true);
    }
    // Only the first tile, compared against the worker's, is decoded on the page as well.
    expect(f.onPage.mock.calls.map(([blob]) => blob)).toEqual([blobs[0]]);
    expect(f.requests.map(request => request.blob)).toEqual(blobs);
    expect(f.requests.every(request => request.maxTileSide === 1024)).toBe(true);
    expect(f.transfers.every(transfer => transfer.length === 1 && transfer[0] instanceof ArrayBuffer)).toBe(true);
    expect(f.worker.createCanvas).toHaveBeenCalledOnce();
    expect(f.worker.clears).toEqual([[0, 0, 4, 4], [0, 0, 4, 4], [0, 0, 2, 2], [0, 0, 2, 2]]);
    expect(f.worker.closes).toHaveBeenCalledTimes(4);
    expect(f.workers.stats()).toMatchObject({ workers: 1, completed: 4, pageDecodes: 1, sharedHeights: 0, parity: "same" });
  });
  it("publish heights in shared memory when the host asks, and transfer them where it cannot", async () => {
    const f = fixture({ kernel: { sharedHeights: true } }); f.setSize(1);
    const blobs = [f.add(tile(4, index => [index * 37 % 256, 3, 5, 255])), f.add(tile(4, () => [127, 255, 128, 255])), f.add(tile(2, () => [0, 0, 0, 255]))];
    const decoded = [];
    for (const blob of blobs) {
      const heights = (await f.workers.decode(blob, f.onPage)).heights;
      expect(sameFloats(heights, (await f.reference(blob)).heights)).toBe(true); decoded.push(heights);
    }
    // The first tile is the page's own, decoded to compare the worker's against.
    expect(decoded.map(heights => heights.buffer instanceof SharedArrayBuffer)).toEqual([false, true, true]);
    expect(f.transfers).toEqual([[], [], []]);
    expect(f.workers.stats()).toMatchObject({ completed: 3, pageDecodes: 1, sharedHeights: 3, parity: "same" });
    vi.stubGlobal("SharedArrayBuffer", function NoSharedMemory() { throw new TypeError("Shared memory is unavailable."); });
    try {
      const heights = (await f.workers.decode(blobs[1], f.onPage)).heights;
      expect(heights.buffer).toBeInstanceOf(ArrayBuffer); expect(sameFloats(heights, decoded[1])).toBe(true);
      expect(f.transfers[3]).toEqual([heights.buffer]);
    } finally { vi.unstubAllGlobals(); }
    expect(f.workers.stats()).toMatchObject({ completed: 4, sharedHeights: 3 });
    expect(f.kernelErrors).not.toHaveBeenCalled(); expect(f.onError).not.toHaveBeenCalled(); f.workers.dispose();
  });
  it("use workers only once the first tile's worker heights match the page's, and give that tile the page's heights", async () => {
    const f = fixture(); f.setSize(2);
    const blobs = [0, 1, 2].map(value => f.add(tile(2, index => [value, index, 7, 255])));
    const pageFirst = f.onPage.getMockImplementation()!;
    let pageResult: Awaited<ReturnType<typeof pageFirst>> | undefined;
    f.onPage.mockImplementationOnce(async blob => (pageResult = await pageFirst(blob)));
    const results = await Promise.all(blobs.map(blob => f.workers.decode(blob, f.onPage)));
    expect(results[0]).toBe(pageResult);
    expect(f.onPage).toHaveBeenCalledOnce();
    // The two tiles that came during the comparison waited for it, then went to workers.
    expect(f.requests.map(request => request.blob)).toEqual(blobs);
    for (const [index, blob] of blobs.entries()) expect(sameFloats(results[index].heights, (await f.reference(blob)).heights)).toBe(true);
    expect(f.workers.stats()).toMatchObject({ pageDecodes: 1, parity: "same" }); expect(f.onError).not.toHaveBeenCalled();
  });
  it("decode every tile on the page once a worker reads other bytes than the page", async () => {
    const f = fixture(); f.worker.readsOtherBytes();
    const blobs = [[1, 2, 3], [4, 5, 6], [7, 8, 9], [10, 11, 12]].map(([r, g, b]) => f.add(tile(2, () => [r, g, b, 255])));
    // The second and third tiles come while the first is compared; the fourth after the verdict.
    const results = await Promise.all(blobs.slice(0, 3).map(blob => f.workers.decode(blob, f.onPage)));
    results.push(await f.workers.decode(blobs[3], f.onPage));
    for (const [index, blob] of blobs.entries()) expect(sameFloats(results[index].heights, (await f.reference(blob)).heights)).toBe(true);
    expect(f.requests).toHaveLength(1); expect(f.onPage).toHaveBeenCalledTimes(4);
    expect(f.onError).toHaveBeenCalledWith(new Error("A terrain decode worker read different heights than the page; elevation tiles decode on the page."));
    expect(f.workers.stats()).toMatchObject({ pageDecodes: 4, parity: "different", available: false });
  });
  it("compare the next tile when the first cannot be decoded or its loader goes away", async () => {
    const f = fixture(), bad = f.add(tile(2, index => index ? [1, 2, 3, 255] : [1, 2, 3, 0]));
    await expect(f.workers.decode(bad, f.onPage)).rejects.toThrow("Terrain image contains missing samples");
    expect(f.workers.stats().parity).toBe("unchecked");
    const controller = new AbortController(), good = f.add(tile(2, () => [1, 2, 3, 255]));
    const leaving = f.workers.decode(good, f.onPage, { signal: controller.signal });
    controller.abort(new Error("loader disposed"));
    await expect(leaving).rejects.toThrow("loader disposed");
    expect(f.workers.stats().parity).toBe("unchecked"); expect(f.onError).not.toHaveBeenCalled();
    await f.workers.decode(good, f.onPage);
    expect(f.workers.stats().parity).toBe("same");
  });
  it("does not let the last tile's pixels show through a tile with missing samples", async () => {
    const f = fixture(); f.setSize(1);
    await f.workers.decode(f.add(tile(2, () => [1, 2, 3, 255])), f.onPage);
    const holed = f.add(tile(2, index => index === 3 ? [0, 0, 0, 0] : [1, 2, 3, 255]));
    // The fake canvas keeps the last tile beneath a transparent pixel; only the clear removes it.
    await expect(f.workers.decode(holed, f.onPage)).rejects.toThrow("Terrain image contains missing samples");
    await expect(f.reference(holed)).rejects.toThrow("Terrain image contains missing samples");
  });
  it("fail a tile the way the page decoder fails it, without decoding it again on the page", async () => {
    const cases: [string, () => ReturnType<typeof tile> | null, TerrainImageDecodeLimits][] = [
      ["missing samples", () => tile(2, index => index ? [1, 2, 3, 255] : [1, 2, 3, 254]), LIMITS],
      ["not square", () => ({ width: 2, height: 1, rgba: new Uint8ClampedArray(8).fill(255) }), LIMITS],
      ["over the side limit", () => tile(4, () => [1, 2, 3, 255]), { maxTileSide: 2 }],
      ["an invalid side limit", () => tile(1, () => [1, 2, 3, 255]), { maxTileSide: 1025 }],
      ["undecodable bytes", () => null, LIMITS],
    ];
    for (const [name, make, limit] of cases) {
      // A good tile first, so the failing one goes to a worker that has matched the page.
      let current = LIMITS;
      const f = fixture({ limits: () => current }), value = make();
      await f.workers.decode(f.add(tile(2, () => [1, 2, 3, 255])), f.onPage);
      f.onPage.mockClear(); current = limit;
      const blob = value ? f.add(value) : new Blob(["not an image"]);
      const expected = await failure(f.reference(blob));
      const actual = await failure(f.workers.decode(blob, f.onPage));
      expect(expected, name).toBeInstanceOf(Error);
      expect([actual.constructor, actual.name, actual.message], name).toEqual([expected.constructor, expected.name, expected.message]);
      expect(f.onPage, name).not.toHaveBeenCalled();
    }
  });
  it("decode on the page from then on when the worker realm cannot decode", async () => {
    for (const [name, kernel] of [
      ["no OffscreenCanvas", { createCanvas: () => null }],
      ["no createImageBitmap", { createImageBitmap: null }],
    ] as const) {
      const f = fixture({ kernel }), blob = f.add(tile(2, () => [3, 4, 5, 255]));
      const first = await f.workers.decode(blob, f.onPage), second = await f.workers.decode(blob, f.onPage);
      expect(sameFloats(first.heights, (await f.reference(blob)).heights), name).toBe(true);
      expect(second.size, name).toBe(2);
      expect(f.onPage, name).toHaveBeenCalledTimes(2); expect(f.requests, name).toHaveLength(1);
      expect(f.workers.stats().pageDecodes, name).toBe(2); expect(f.onError, name).not.toHaveBeenCalled();
    }
    const noContext = fixture(); noContext.worker.withoutContext();
    const blob = noContext.add(tile(2, () => [3, 4, 5, 255]));
    expect((await noContext.workers.decode(blob, noContext.onPage)).size).toBe(2);
    expect(noContext.onPage).toHaveBeenCalledOnce();
  });
  it("decode on the page when workers are off, missing, or lost mid-tile", async () => {
    const off = fixture(); off.setSize(0);
    const pixels = tile(2, () => [9, 8, 7, 255]);
    await off.workers.decode(off.add(pixels), off.onPage);
    expect(off.createWorker).not.toHaveBeenCalled(); expect(off.onPage).toHaveBeenCalledOnce();
    const missing = fixture({ bridge: { createWorker: () => null } });
    await missing.workers.decode(missing.add(pixels), missing.onPage);
    expect(missing.onPage).toHaveBeenCalledOnce();
    const lost = fixture(); lost.setSize(1);
    const blob = lost.add(pixels), decoding = lost.workers.decode(blob, lost.onPage);
    lost.ports[0].onerror?.({ message: "worker crashed" } as ErrorEvent);
    expect(sameFloats((await decoding).heights, (await lost.reference(blob)).heights)).toBe(true);
    expect(lost.onPage).toHaveBeenCalledOnce(); expect(lost.onError).toHaveBeenCalledOnce();
    // One lost worker leaves the pool up, so the next tile is compared instead.
    const next = lost.add(tile(2, () => [6, 5, 4, 255]));
    expect(sameFloats((await lost.workers.decode(next, lost.onPage)).heights, (await lost.reference(next)).heights)).toBe(true);
    expect(lost.workers.stats()).toMatchObject({ parity: "same", losses: 1, available: true });
  });
  it("drop an aborted tile without decoding it anywhere", async () => {
    const f = fixture(), blob = f.add(tile(2, () => [1, 1, 1, 255]));
    await f.workers.decode(f.add(tile(2, () => [2, 2, 2, 255])), f.onPage); f.onPage.mockClear(); f.requests.length = 0;
    await expect(f.workers.decode(blob, f.onPage, { signal: AbortSignal.abort(new Error("gone")) })).rejects.toThrow("gone");
    expect(f.requests).toHaveLength(0);
    const controller = new AbortController(), running = f.workers.decode(blob, f.onPage, { signal: controller.signal });
    controller.abort(new Error("loader disposed"));
    await expect(running).rejects.toThrow("loader disposed");
    expect(f.onPage).not.toHaveBeenCalled();
  });
  it("can decode as many tiles at once as there are workers, and none once tiles decode on the page", async () => {
    const f = fixture(); f.setSize(5);
    expect(f.workers.capacity()).toBe(5);
    f.setSize(40); expect(f.workers.capacity()).toBe(16);
    f.setSize(2.5); expect(f.workers.capacity()).toBe(2);
    f.setSize(0); expect(f.workers.capacity()).toBe(0);
    f.setSize(3); await f.workers.decode(f.add(tile(2, () => [1, 2, 3, 255])), f.onPage);
    expect(f.workers.capacity()).toBe(3);
    f.workers.dispose(); expect(f.workers.capacity()).toBe(0);
    const different = fixture(); different.worker.readsOtherBytes();
    await different.workers.decode(different.add(tile(2, () => [1, 2, 3, 255])), different.onPage);
    expect(different.workers.capacity()).toBe(0);
    const unable = fixture({ kernel: { createCanvas: () => null } });
    await unable.workers.decode(unable.add(tile(2, () => [1, 2, 3, 255])), unable.onPage);
    expect(unable.workers.capacity()).toBe(0);
    const missing = fixture({ bridge: { createWorker: () => null } });
    await missing.workers.decode(missing.add(tile(2, () => [1, 2, 3, 255])), missing.onPage);
    expect(missing.workers.capacity()).toBe(0);
  });
  it("never uses a worker that returns malformed heights", async () => {
    const f = fixture({ bridge: { createWorker: () => {
      const port: TerrainDecodeWorkerPort = { onmessage: null, onerror: null, terminate() {},
        postMessage(request) { queueMicrotask(() => port.onmessage?.({ data: { kind: "decoded-terrain", id: request.id, size: 3, heights: new Float32Array(4) } } as MessageEvent<TerrainDecodeWorkerReply>)); } };
      return port;
    } } });
    const blob = f.add(tile(2, () => [1, 1, 1, 255]));
    expect(sameFloats((await f.workers.decode(blob, f.onPage)).heights, (await f.reference(blob)).heights)).toBe(true);
    expect(f.onError).toHaveBeenCalledWith(new Error("A terrain decode worker returned malformed heights."));
    await f.workers.decode(blob, f.onPage);
    expect(f.workers.stats()).toMatchObject({ parity: "different", pageDecodes: 2, available: false });
  });
});
