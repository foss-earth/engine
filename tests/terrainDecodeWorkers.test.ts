import { describe, expect, it, vi } from "vitest";
import { createTerrainImageDecoder, type TerrainImageDecodeLimits } from "../src/browser/terrainImageDecoder.js";
import { installTerrainDecodeWorkerKernel, type TerrainDecodeWorkerKernelPorts } from "../src/browser/terrainDecodeWorkerKernel.js";
import { createTerrainDecodeWorkers, type TerrainDecodeWorkersOptions } from "../src/browser/terrainDecodeWorkers.js";
import type { TerrainDecodeWorkerPort, TerrainDecodeWorkerReply, TerrainDecodeWorkerRequest } from "../src/browser/terrainDecodeWorkerProtocol.js";

/** Fake native image realm: each Blob stands for a tile whose RGBA pixels are known. */
function imageRealm(tiles: Map<Blob, { width: number; height: number; rgba: Uint8ClampedArray }>) {
  const closes = vi.fn(), clears: number[][] = [];
  let contextAvailable = true;
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
      getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: drawn.slice(0, w * h * 4) }),
    };
    return { width, height, getContext: () => contextAvailable ? context : null } as unknown as OffscreenCanvas;
  });
  return { createImageBitmap, createCanvas, closes, clears, withoutContext() { contextAvailable = false; } };
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
  it("return the page decoder's exact heights, transfer them, and reuse one cleared canvas per worker", async () => {
    const f = fixture(); f.setSize(1);
    const blobs = [f.add(tile(4, index => [index * 37 % 256, index * 91 % 256, index * 53 % 256, 255])),
      f.add(tile(4, () => [127, 255, 128, 255])), f.add(tile(2, () => [0, 0, 0, 255])), f.add(tile(2, () => [255, 255, 255, 255]))];
    for (const blob of blobs) {
      const decoded = await f.workers.decode(blob, f.onPage), expected = await f.reference(blob);
      expect(decoded.size).toBe(expected.size); expect(sameFloats(decoded.heights, expected.heights)).toBe(true);
    }
    expect(f.onPage).not.toHaveBeenCalled();
    expect(f.requests.map(request => request.blob)).toEqual(blobs);
    expect(f.requests.every(request => request.maxTileSide === 1024)).toBe(true);
    expect(f.transfers.every(transfer => transfer.length === 1 && transfer[0] instanceof ArrayBuffer)).toBe(true);
    expect(f.worker.createCanvas).toHaveBeenCalledOnce();
    expect(f.worker.clears).toEqual([[0, 0, 4, 4], [0, 0, 4, 4], [0, 0, 2, 2], [0, 0, 2, 2]]);
    expect(f.worker.closes).toHaveBeenCalledTimes(4);
    expect(f.workers.stats()).toMatchObject({ workers: 1, completed: 4, pageDecodes: 0 });
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
      const f = fixture({ limits: () => limit }), value = make();
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
  });
  it("drop an aborted tile without decoding it anywhere", async () => {
    const f = fixture(), blob = f.add(tile(2, () => [1, 1, 1, 255]));
    await expect(f.workers.decode(blob, f.onPage, { signal: AbortSignal.abort(new Error("gone")) })).rejects.toThrow("gone");
    expect(f.requests).toHaveLength(0);
    const controller = new AbortController(), running = f.workers.decode(blob, f.onPage, { signal: controller.signal });
    controller.abort(new Error("loader disposed"));
    await expect(running).rejects.toThrow("loader disposed");
    expect(f.onPage).not.toHaveBeenCalled();
  });
  it("rejects malformed heights from a worker", async () => {
    const f = fixture({ bridge: { createWorker: () => {
      const port: TerrainDecodeWorkerPort = { onmessage: null, onerror: null, terminate() {},
        postMessage(request) { queueMicrotask(() => port.onmessage?.({ data: { kind: "decoded-terrain", id: request.id, size: 3, heights: new Float32Array(4) } } as MessageEvent<TerrainDecodeWorkerReply>)); } };
      return port;
    } } });
    await expect(f.workers.decode(f.add(tile(2, () => [1, 1, 1, 255])), f.onPage)).rejects.toThrow("malformed heights");
  });
});
