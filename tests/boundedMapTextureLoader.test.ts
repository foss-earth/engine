import { describe, expect, it, vi } from "vitest";
import { createImageSessionBroker } from "@foss-earth/images";
import { createImageFileService } from "@foss-earth/images/browser";
import type { ImageTextureUploader, UploadedImageTexture, UploadTicket, ImageUploadRequest } from "@foss-earth/renderer/babylon";
import { createBoundedMapTextureLoader } from "../src/babylon/imagery/boundedMapTextureLoader.js";
const png=new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,2,0,0,0,1,8,6,0,0,0,0,0,0,0]);
const file={url:"https://fixture.invalid/tile.png",width:2,height:1,mimeType:"image/png" as const};
function fixture() {
  // Two simultaneously held 2x1 RGBA mip chains require 2x12 bytes. Overlap
  // limits a subset of sourceGpu; it never supplies extra sourceGpu capacity.
  const broker=createImageSessionBroker({pools:{sourceGpu:24,encoded:256,decoded:256,uploadOutstanding:256,overlap:20},requests:1,decodes:1});
  const close=vi.fn(),bitmap={width:2,height:1,close} as unknown as ImageBitmap;
  const fetch=vi.fn(async()=>new Response(png,{headers:{"content-type":"image/png"}}));
  const files=createImageFileService({broker,limits:()=>({responseBytes:256,timeoutMs:1000}),priority:()=>-1,fetch,decode:async()=>bitmap});
  const texture={gammaSpace:true},dispose=vi.fn(),uploaded={kind:"2d",width:2,height:1,levels:2,gpuBytes:12,texture,complete:true,dispose} as unknown as UploadedImageTexture;
  const upload=vi.fn(async(_request:ImageUploadRequest)=>{void _request;return uploaded;}),uploader={upload} as unknown as ImageTextureUploader;
  const whenReady=vi.fn(async()=>{}),load=createBoundedMapTextureLoader({broker,files,uploader,maxTextureSide:()=>256,whenReady});
  return {broker,files,uploaded,dispose,upload,close,fetch,whenReady,load};
}
describe("shared bounded map acquisition",()=>{
  it("keeps source GPU/overlap until the host atomic swap and uses original map colour flags",async()=>{
    const f=fixture(),first=await f.load(file,{declaredBytes:png.length,priority:2}),next=await f.load(file,{declaredBytes:png.length,priority:9,overlap:true});
    expect(f.upload.mock.calls[0][0]).toMatchObject({kind:"2d",textureColor:{useSRGBBuffer:false,gammaSpace:true}});
    expect(f.close).toHaveBeenCalledTimes(2);expect(f.broker.pools.stats().overlap.reserved).toBe(12);expect(f.whenReady).toHaveBeenCalledTimes(2);
    first.dispose();expect(f.broker.pools.stats().overlap.reserved).toBe(12);next.settleReplacement();expect(f.broker.pools.stats().overlap.reserved).toBe(0);
    next.dispose();expect(f.broker.pools.live()).toEqual([]);f.broker.dispose();
  });
  it("cancels late native submission without freeing the renderer's direct completion ticket",async()=>{
    const f=fixture(),controller=new AbortController(),remove=vi.spyOn(controller.signal,"removeEventListener");let finish!:(value:UploadedImageTexture)=>void,started!:()=>void,ticket!:UploadTicket;
    const began=new Promise<void>(resolve=>{started=resolve;});
    f.upload.mockImplementationOnce(request=>{ticket=request.reserveUpload(8,"nonabortable native copy");started();return new Promise(resolve=>{finish=resolve;});});
    const work=f.load(file,{declaredBytes:png.length,priority:1,signal:controller.signal}),failure=expect(work).rejects.toThrow();await began;controller.abort();
    expect(f.broker.pools.stats().uploadOutstanding.reserved).toBe(8);expect(f.close).not.toHaveBeenCalled();expect(f.broker.pools.stats().decoded.reserved).toBe(8);finish(f.uploaded);await failure;expect(f.dispose).toHaveBeenCalledTimes(1);expect(f.whenReady).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledWith("abort",expect.any(Function));expect(f.broker.pools.stats().uploadOutstanding.reserved).toBe(8);ticket.release();expect(f.broker.pools.live()).toEqual([]);f.broker.dispose();
  });
  it("refuses unsupported declared sizes before allocating/reading and removes external listener on generation loss",async()=>{
    const f=fixture();await expect(f.load({...file,width:257},{declaredBytes:1,priority:1})).rejects.toThrow(/dimensions/);expect(f.fetch).not.toHaveBeenCalled();
    const controller=new AbortController(),remove=vi.spyOn(controller.signal,"removeEventListener"),held=await f.load(file,{declaredBytes:png.length,priority:1,signal:controller.signal});
    f.broker.invalidate();expect(held.isCurrent()).toBe(false);expect(remove).toHaveBeenCalledWith("abort",expect.any(Function));expect(f.broker.pools.live()).toEqual([]);held.dispose();f.broker.dispose();
  });
});


describe("bounded map input cleanup failures", () => {
  it("releases retained bitmap pixels and uploaded ownership even when native close throws", async () => {
    const f = fixture(), error = new Error("native bitmap close failed"); f.close.mockImplementationOnce(() => { throw error; });
    await expect(f.load(file, { declaredBytes: png.length, priority: 1 })).rejects.toThrow(error);
    expect(f.dispose).toHaveBeenCalledOnce(); expect(f.broker.pools.live()).toEqual([]); f.broker.dispose();
  });
});
