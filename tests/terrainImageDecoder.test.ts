import { describe, expect, it, vi } from "vitest";
import { createTerrainImageDecoder, DEFAULT_TERRAIN_IMAGE_DECODE_LIMITS } from "../src/browser/terrainImageDecoder.js";
function fixture(width = 1, height = width) {
  const data = new Uint8ClampedArray(width * height * 4); for (let index = 0; index < data.length; index += 4) data.set([127,255,128,255],index);
  const close = vi.fn(), bitmap = { width, height, close } as unknown as ImageBitmap;
  const drawImage = vi.fn(), context = { drawImage, getImageData: () => ({ data }) };
  const canvas = { width: 0, height: 0, getContext: vi.fn(() => context) } as unknown as HTMLCanvasElement;
  const createImageBitmap = vi.fn(async () => bitmap), createCanvas = vi.fn(() => canvas), onDecodeCpu = vi.fn(); let time = 8;
  const ports = { createImageBitmap, createCanvas, nowMs: () => { time += 3; return time; }, limits: () => DEFAULT_TERRAIN_IMAGE_DECODE_LIMITS, onDecodeCpu };
  const decode = createTerrainImageDecoder(ports); return { data, close, bitmap, canvas, context, createImageBitmap, createCanvas, onDecodeCpu, ports, decode };
}
describe("original native Terrarium decode with explicit host ports", () => {
  it("passes a WebP blob unchanged with raw color/alpha options and the original height formula", async () => {
    const f = fixture(), blob = new Blob(["native fixture"], { type: "image/webp" });
    expect(await f.decode(blob)).toEqual({ size: 1, heights: new Float32Array([-0.5]) });
    expect(f.createImageBitmap).toHaveBeenCalledWith(blob,{colorSpaceConversion:"none",premultiplyAlpha:"none"}); expect(f.canvas.width).toBe(1); expect(f.canvas.height).toBe(1);
    expect(f.context.drawImage).toHaveBeenCalledWith(f.bitmap,0,0); expect(f.close).toHaveBeenCalledOnce(); expect(f.onDecodeCpu).toHaveBeenCalledWith(3);
  });
  it("accepts the original 1024-pixel boundary and honors a smaller named limit", async () => {
    const f = fixture(1024); expect((await f.decode(new Blob())).size).toBe(1024); expect(f.close).toHaveBeenCalledOnce();
    const small = fixture(2); small.ports.limits = () => ({ maxTileSide: 1 }); await expect(small.decode(new Blob())).rejects.toThrow("Invalid terrain tile size"); expect(small.createCanvas).not.toHaveBeenCalled(); expect(small.close).toHaveBeenCalledOnce();
  });
  for (const size of [[1025,1025],[2,3]]) it(`closes invalid ${size[0]} by ${size[1]} native tiles before canvas allocation`, async () => {
    const f = fixture(...size as [number,number]); await expect(f.decode(new Blob())).rejects.toThrow("Invalid terrain tile size"); expect(f.createCanvas).not.toHaveBeenCalled(); expect(f.close).toHaveBeenCalledOnce(); expect(f.onDecodeCpu).toHaveBeenCalled();
  });
  it("closes native input on missing samples and unavailable context", async () => {
    const missing = fixture(); missing.data[3]=0; await expect(missing.decode(new Blob())).rejects.toThrow("missing samples"); expect(missing.close).toHaveBeenCalledOnce();
    const unavailable = fixture(); (unavailable.canvas.getContext as unknown as ReturnType<typeof vi.fn>).mockReturnValue(null); await expect(unavailable.decode(new Blob())).rejects.toThrow("decoder unavailable"); expect(unavailable.close).toHaveBeenCalledOnce();
  });
  it("attempts bitmap cleanup and CPU reporting independently, preserving decode and cleanup causes", async () => {
    const f=fixture();f.data[3]=0;const cleanup=new Error("bitmap close");f.close.mockImplementationOnce(()=>{throw cleanup;});
    const error=await f.decode(new Blob()).catch((error:unknown)=>error);expect(error).toBeInstanceOf(AggregateError);expect((error as AggregateError).errors[1]).toBe(cleanup);expect(f.onDecodeCpu).toHaveBeenCalledOnce();
  });
  it("rejects invalid named limits before native allocation and performs no timing when no sample was requested", async () => {
    const f=fixture();f.ports.limits=()=>({maxTileSide:1025});await expect(f.decode(new Blob())).rejects.toThrow("1–1024");expect(f.createImageBitmap).not.toHaveBeenCalled();
    const nowMs=vi.fn(()=>0);await createTerrainImageDecoder({...fixture().ports,nowMs,onDecodeCpu:undefined})(new Blob());expect(nowMs).not.toHaveBeenCalled();
  });
});
