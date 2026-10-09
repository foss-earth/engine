import { describe, expect, it, vi } from "vitest";
import { createImageSessionBroker, ResourceCapacityError } from "@foss-earth/images";
import { createImageFileService, createCanvasRgbaSurface, type RgbaReadbackSurface } from "@foss-earth/images/browser";
import { createBoundedAtlasImageryLoader } from "../src/browser/boundedAtlasImageryLoader.js";
import { pageUploadBytes } from "../src/terrain/imagery/imageryAtlasLayout.js";
import { ImageryMissingError } from "../src/terrain/imagery/imageryResidency.js";

function png(width = 256, height = 256): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,0,0,0,0,0,8,6,0,0,0,0,0,0,0]);
  const view = new DataView(bytes.buffer); view.setUint32(16, width); view.setUint32(20, height); return bytes;
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((a,b) => { resolve = a; reject = b; }); return { promise, resolve, reject };
}
const pixelBytes = 256 * 256 * 4;
function pixels(alpha = 255): Uint8ClampedArray {
  const data = new Uint8ClampedArray(pixelBytes); for (let i = 3; i < data.length; i += 4) data[i] = alpha; return data;
}
function fixture(decodedBytes = 2_000_000) {
  const broker = createImageSessionBroker({ requests: 1, decodes: 1,
    pools: { sourceGpu: 0, overlap: 0, encoded: 1000, decoded: decodedBytes, uploadOutstanding: 0 } });
  const closeBitmap = vi.fn(), bitmap = { width: 256, height: 256, close: closeBitmap } as unknown as ImageBitmap;
  const fetch = vi.fn(async () => new Response(png(), { headers: { "content-type": "image/png" } }));
  const decode = vi.fn(async () => bitmap);
  const files = createImageFileService({ broker, fetch, decode, priority: () => -1, limits: () => ({ responseBytes: 1000, timeoutMs: 1000 }) });
  const read = vi.fn((_image: ImageBitmap): Uint8ClampedArray | Promise<Uint8ClampedArray> => { void _image; return pixels(); });
  const disposeSurface = vi.fn(), createSurface = vi.fn((_width: number, _height: number): RgbaReadbackSurface => { void _width; void _height; return { read, dispose: disposeSurface }; });
  const describe = vi.fn(() => ({ declaredBytes: 1 })), onBytes = vi.fn();
  const loader = createBoundedAtlasImageryLoader({ broker, files, describe, priority: () => 3, createSurface, onBytes });
  const load = (signal = new AbortController().signal, priority?: number) => loader.load("https://fixture.invalid/map", { width: 256, height: 256 }, signal, priority);
  return { broker, files, fetch, decode, read, closeBitmap, bitmap, disposeSurface, createSurface, describe, onBytes, loader, load };
}

describe("bounded Atlas page production using actual common acquisition", () => {
  it("infers bytes without URL guessing, retains exact prepared pages, and borrows the shared session", async () => {
    const f = fixture(), obtain = vi.spyOn(f.files, "obtainInferred"), decode = vi.spyOn(f.files, "decode");
    const image = await f.load(undefined, 19);
    expect(f.loader.offThread).toBe(false); expect(image.compressedBytes).toBe(png().length);
    expect(f.onBytes.mock.calls.flat().reduce((a,b) => a+b, 0)).toBe(png().length);
    expect(obtain.mock.calls[0][0]).toMatchObject({ width: 256, height: 256, mimeType: undefined });
    expect(obtain.mock.calls[0][4]).toBe(19); expect(decode.mock.calls[0][3]).toBe(19);
    expect(f.createSurface).toHaveBeenCalledWith(256,256); expect(f.read).toHaveBeenCalledWith(f.bitmap);
    expect(image.pages).toHaveLength(1); expect(image.pages[0].map(level => level.byteLength)).toEqual([331776,82944,20736,5184,1296]);
    expect(image.pages[0][0].slice(0,4)).toEqual(new Uint8Array([0,0,0,255]));
    expect(f.closeBitmap).toHaveBeenCalledOnce(); expect(f.disposeSurface).toHaveBeenCalledOnce();
    expect(f.broker.pools.stats().decoded.reserved).toBe(pageUploadBytes());
    const end = image.retain(); image.close(); expect(image.isCurrent()).toBe(false);
    expect(image.pages[0][0][3]).toBe(255); expect(() => image.retain()).toThrow("closing");
    expect(f.broker.pools.stats().decoded.reserved).toBe(pageUploadBytes()); end(); end(); image.close();
    expect(() => image.pages).toThrow("closed"); expect(f.broker.pools.live()).toEqual([]);
    f.loader.dispose(); expect(f.broker.generation()).toBe(0); const scope = f.broker.scope(); scope.dispose(); f.broker.dispose();
  });
  it("adopts the host default priority and refuses invalid page dimensions before transport", async () => {
    const f = fixture(), obtain = vi.spyOn(f.files, "obtainInferred");
    const image = await f.load(); expect(obtain.mock.calls[0][4]).toBe(3); image.close();
    await expect(f.loader.load("https://fixture.invalid/map", { width: 257, height: 256 }, new AbortController().signal)).rejects.toThrow("256-pixel");
    expect(f.fetch).toHaveBeenCalledOnce(); f.loader.dispose(); f.broker.dispose();
  });
  it("charges the separately held RGBA input and exact page output before releasing the source bitmap", async () => {
    const f = fixture(), makeScope = f.broker.scope.bind(f.broker); let admittedOutput = false;
    vi.spyOn(f.broker, "scope").mockImplementation(() => {
      const scope = makeScope(), reserve = scope.reserve.bind(scope);
      vi.spyOn(scope, "reserve").mockImplementation((pool, bytes, label) => {
        if (label.endsWith("prepared Atlas pages")) {
          expect(f.broker.pools.stats().decoded.reserved).toBe(2 * pixelBytes);
          expect(pool).toBe("decoded"); expect(bytes).toBe(441936); admittedOutput = true;
        }
        return reserve(pool, bytes, label);
      });
      return scope;
    });
    f.read.mockImplementationOnce(() => { expect(f.broker.pools.stats().decoded.reserved).toBe(3 * pixelBytes); return pixels(); });
    f.closeBitmap.mockImplementationOnce(() => { expect(admittedOutput).toBe(true); expect(f.broker.pools.stats().decoded.reserved).toBe(pixelBytes + 441936); });
    const image = await f.load(); expect(pageUploadBytes()).toBe(441936);
    expect(f.broker.pools.stats().decoded.reserved).toBe(441936); image.close();
    expect(f.broker.pools.live()).toEqual([]); f.loader.dispose(); f.broker.dispose();
  });
  it("refuses prepared output beyond the common decoded cap and cleans all prior native inputs", async () => {
    const f = fixture(3 * pixelBytes);
    await expect(f.load()).rejects.toBeInstanceOf(ResourceCapacityError);
    expect(f.createSurface).toHaveBeenCalledOnce(); expect(f.closeBitmap).toHaveBeenCalledOnce();
    expect(f.disposeSurface).toHaveBeenCalledOnce(); expect(f.broker.pools.live()).toEqual([]); f.loader.dispose(); f.broker.dispose();
  });
  it("keeps opaque black but classifies fully transparent pixels as source missing", async () => {
    const f = fixture(); f.read.mockReturnValueOnce(pixels(0));
    await expect(f.load()).rejects.toBeInstanceOf(ImageryMissingError); expect(f.broker.pools.live()).toEqual([]);
    const black = await f.load(); expect(black.pages).toHaveLength(1); black.close(); f.loader.dispose(); f.broker.dispose();
  });
  for (const status of [404,204,429,500]) {
    it(`maps HTTP ${status} only through the actual transport type`, async () => {
      const f = fixture(); f.fetch.mockImplementationOnce(async () => new Response(null, { status }));
      const error = await f.load().catch((error: unknown) => error);
      expect(error instanceof ImageryMissingError).toBe(status === 404 || status === 204);
      expect(f.decode).not.toHaveBeenCalled(); expect(f.createSurface).not.toHaveBeenCalled(); expect(f.broker.pools.live()).toEqual([]);
      f.loader.dispose(); f.broker.dispose();
    });
  }
  it("maps final typed header/native size disagreement but never arbitrary dimension-looking messages", async () => {
    const f = fixture(); f.fetch.mockImplementationOnce(async () => new Response(png(512), { headers: { "content-type": "image/png" } }));
    await expect(f.load()).rejects.toBeInstanceOf(ImageryMissingError); expect(f.decode).not.toHaveBeenCalled();
    f.decode.mockResolvedValueOnce({ width: 512, height: 256, close: f.closeBitmap } as unknown as ImageBitmap);
    await expect(f.load()).rejects.toBeInstanceOf(ImageryMissingError);
    f.decode.mockRejectedValueOnce(new Error("Decoded image is 512×256, declared 256×256."));
    const arbitrary = await f.load().catch((error: unknown) => error); expect(arbitrary).not.toBeInstanceOf(ImageryMissingError);
    expect(f.broker.pools.live()).toEqual([]); f.loader.dispose(); f.broker.dispose();
  });
  it("preserves typed dimension causes through throwing late native cleanup", async () => {
    const f = fixture(); f.decode.mockResolvedValueOnce({ width: 512, height: 256, close() { throw new Error("native cleanup"); } } as unknown as ImageBitmap);
    const error = await f.load().catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ImageryMissingError);
    expect((error as Error).cause).toBeInstanceOf(Error); expect(f.broker.pools.live()).toEqual([]); f.loader.dispose(); f.broker.dispose();
  });
  for (const end of ["parent", "loader", "generation", "broker"] as const) for (const result of ["resolve", "reject"] as const) {
    it(`${end} keeps pending native readback charged until ${result} and closes source after surface`, async () => {
      const f = fixture(), started = deferred<void>(), native = deferred<Uint8ClampedArray>(), controller = new AbortController();
      f.read.mockImplementationOnce(() => { started.resolve(); return native.promise; });
      f.disposeSurface.mockImplementationOnce(() => { expect(f.closeBitmap).not.toHaveBeenCalled(); expect(f.broker.pools.stats().decoded.reserved).toBe(3 * pixelBytes); });
      const work = f.load(controller.signal), rejected = expect(work).rejects.toThrow(); await started.promise;
      if (end === "parent") controller.abort(); else if (end === "loader") f.loader.dispose(); else if (end === "generation") f.broker.invalidate(); else f.broker.dispose();
      expect(f.closeBitmap).not.toHaveBeenCalled(); expect(f.disposeSurface).not.toHaveBeenCalled(); expect(f.broker.pools.stats().decoded.reserved).toBe(3 * pixelBytes);
      if (result === "resolve") native.resolve(pixels()); else native.reject(new Error("native readback failed"));
      await rejected; expect(f.disposeSurface).toHaveBeenCalledOnce(); expect(f.closeBitmap).toHaveBeenCalledOnce(); expect(f.broker.pools.live()).toEqual([]);
      f.loader.dispose(); f.broker.dispose();
    });
  }
  it("preserves surface and bitmap cleanup failures while releasing every charge", async () => {
    const f = fixture(); f.disposeSurface.mockImplementationOnce(() => { throw new Error("surface cleanup"); });
    f.closeBitmap.mockImplementationOnce(() => { throw new Error("bitmap cleanup"); });
    let canvas: HTMLCanvasElement;
    f.createSurface.mockImplementationOnce((width, height) => {
      canvas = { width, height, getContext: () => ({ drawImage() {}, getImageData: () => ({ data: pixels() }) }) } as unknown as HTMLCanvasElement;
      const surface = createCanvasRgbaSurface({ width, height, createCanvas: () => canvas });
      return { ...surface, dispose() {
        // The actual common adapter observes zero backing storage and reports
        // retirement before the independent post-retirement cleanup fails.
        surface.dispose(); expect(canvas.width).toBe(0); expect(canvas.height).toBe(0); f.disposeSurface();
      } };
    });
    const error = await f.load().catch((error: unknown) => error); expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors.map((value: Error) => value.message)).toEqual(["surface cleanup","bitmap cleanup"]);
    expect(f.broker.pools.live()).toEqual([]); f.loader.dispose(); f.broker.dispose();
  });
  it("keeps held prepared inputs charged across broker invalidation and removes parent listeners", async () => {
    const f = fixture(), controller = new AbortController(), remove = vi.spyOn(controller.signal,"removeEventListener");
    const image = await f.load(controller.signal), end = image.retain(); f.broker.invalidate();
    expect(image.isCurrent()).toBe(false); expect(image.pages[0][0][3]).toBe(255);
    expect(f.broker.pools.stats().decoded.reserved).toBe(pageUploadBytes()); expect(remove).toHaveBeenCalledWith("abort",expect.any(Function));
    end(); expect(f.broker.pools.live()).toEqual([]); f.loader.dispose(); await expect(f.load()).rejects.toThrow("disposed"); f.broker.dispose();
  });
  it("retains pending decoder input after generation loss and never turns its late size observation into missing", async () => {
    const f = fixture(), started = deferred<void>(), native = deferred<ImageBitmap>();
    f.decode.mockImplementationOnce(() => { started.resolve(); return native.promise; });
    const work = f.load(), result = work.catch((error: unknown) => error); await started.promise; f.broker.invalidate();
    expect(f.broker.pools.stats().decoded.reserved).toBe(pixelBytes);
    expect(f.broker.pools.stats().encoded.reserved).toBe(png().length);
    native.resolve({ width:512,height:256,close:f.closeBitmap } as unknown as ImageBitmap);
    const error = await result; expect(error).toBeInstanceOf(Error); expect(error).not.toBeInstanceOf(ImageryMissingError);
    expect(f.closeBitmap).toHaveBeenCalledOnce(); expect(f.createSurface).not.toHaveBeenCalled(); expect(f.broker.pools.live()).toEqual([]); f.loader.dispose(); f.broker.dispose();
  });
  it("preserves cached mismatch forget/refetch and never detaches the encoded input retained by pending cache writes", async () => {
    const f=fixture(), write=deferred<void>();let kept:{bytes:Uint8Array;contentType:string|null}|null={bytes:png(512),contentType:"image/png"},stored:Uint8Array|null=null;
    const forget=vi.fn(()=>{kept=null;});
    const files=createImageFileService({broker:f.broker,fetch:f.fetch,decode:f.decode,priority:()=>0,limits:()=>({responseBytes:1000,timeoutMs:1000}),
      cache:{files:{get:async()=>kept,getBounded:async(_url,admission)=>kept&&admission.admit(kept.bytes.length)?kept:null,
        put(_url,bytes){stored=bytes;},forget},settled:()=>write.promise}});
    const loader=createBoundedAtlasImageryLoader({broker:f.broker,files,describe:()=>({declaredBytes:1}),priority:()=>0,createSurface:f.createSurface});
    const image=await loader.load("https://fixture.invalid/map",{width:256,height:256},new AbortController().signal);
    expect(forget).toHaveBeenCalledOnce();expect(f.fetch).toHaveBeenCalledOnce();expect(image.compressedBytes).toBe(png().length);
    image.close();f.broker.invalidate();expect((stored as Uint8Array|null)?.byteLength).toBe(png().length);
    expect(f.broker.pools.stats().encoded.reserved).toBe(2*png().length);
    write.resolve();for(let i=0;i<6;i++)await Promise.resolve();expect(f.broker.pools.live()).toEqual([]);
    loader.dispose();f.loader.dispose();f.broker.dispose();
  });
  it("gives generation loss during cleanup precedence over a transparent missing observation", async () => {
    const f = fixture(); f.read.mockReturnValueOnce(pixels(0));
    f.closeBitmap.mockImplementationOnce(() => { f.broker.invalidate(); });
    const error = await f.load().catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error); expect(error).not.toBeInstanceOf(ImageryMissingError);
    expect(f.closeBitmap).toHaveBeenCalledOnce(); expect(f.broker.pools.live()).toEqual([]);
    f.loader.dispose(); f.broker.dispose();
  });
  it("never classifies cleanup-only failures as missing even if their message resembles transport evidence", async () => {
    const f = fixture(); f.closeBitmap.mockImplementationOnce(() => { throw new Error("404; declared 512×256"); });
    const error = await f.load().catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error); expect(error).not.toBeInstanceOf(ImageryMissingError);
    expect(f.broker.pools.live()).toEqual([]); f.loader.dispose(); f.broker.dispose();
  });
  it("never recasts unsupported signatures or served MIME disagreements as missing", async () => {
    const f = fixture(); f.fetch.mockImplementationOnce(async () => new Response(new Uint8Array([1,2,3])));
    expect(await f.load().catch((error: unknown) => error)).not.toBeInstanceOf(ImageryMissingError);
    f.fetch.mockImplementationOnce(async () => new Response(png(), { headers: { "content-type": "image/jpeg" } }));
    expect(await f.load().catch((error: unknown) => error)).not.toBeInstanceOf(ImageryMissingError);
    expect(f.broker.pools.live()).toEqual([]); f.loader.dispose(); f.broker.dispose();
  });
});
