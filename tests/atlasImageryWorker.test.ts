import { describe, expect, it } from "vitest";
import { createImageFileService } from "@foss-earth/images/browser";
import { createBoundedAtlasImageryLoader } from "../src/browser/boundedAtlasImageryLoader.js";
import { ImageryMissingError } from "../src/terrain/imagery/imageryResidency.js";
import { pageUploadBytes } from "../src/terrain/imagery/imageryAtlasLayout.js";
import { atlasWorkerHost, deferredWorker, flushWorker } from "../fixtures/composition/atlasWorkerHost.js";

describe("actual common acquisition with original worker preparation transport",()=>{
  it("selects the actual worker, transfers private encoded input and all original mip outputs, retaining only the held pages",async()=>{
    const h=atlasWorkerHost();try{expect(h.loader.offThread).toBe(true);const before=h.png.slice();const image=await h.load();expect(h.requests.map(request=>request.kind)).toEqual(["decode","prepare"]);
      expect(h.png).toEqual(before);expect(h.png[0]).toBe(137);expect(image.pages[0].map(level=>level.byteLength)).toEqual([331776,82944,20736,5184,1296]);
      expect(h.replies.some(reply=>reply.kind==="prepared")).toBe(true);expect(h.nativeCloses).toHaveBeenCalledOnce();expect(h.surfaceCloses).toHaveBeenCalledOnce();
      expect(h.broker.pools.stats().encoded.reserved).toBe(0);expect(h.broker.pools.stats().decoded.reserved).toBe(pageUploadBytes());const end=image.retain();image.close();expect(image.pages[0][0][3]).toBe(255);end();expect(h.broker.pools.live()).toEqual([]);
    }finally{h.dispose();}
  });
  it("falls back faithfully without claiming off-thread work when the factory has no worker",async()=>{
    const h=atlasWorkerHost(false);try{expect(h.loader.offThread).toBe(false);const image=await h.load();expect(h.requests).toEqual([]);expect(image.pages).toHaveLength(1);image.close();expect(h.broker.pools.live()).toEqual([]);}finally{h.dispose();}
  });
  it("requires the same broker and exact common service wired to the bridge",()=>{
    const h=atlasWorkerHost();const foreign=createImageFileService({broker:h.broker,fetch:async()=>new Response(),decode:h.decode,priority:()=>0,limits:()=>({responseBytes:1,timeoutMs:1})});
    try{expect(()=>createBoundedAtlasImageryLoader({broker:h.broker,files:foreign,worker:h.bridge,describe:()=>({declaredBytes:1}),priority:()=>0,createSurface:h.createSurface})).toThrow("exact common file service");}finally{h.dispose();}
  });
  it("classifies actual transparent worker output as missing and keeps opaque black",async()=>{
    const h=atlasWorkerHost();try{h.setAlpha(0);await expect(h.load()).rejects.toBeInstanceOf(ImageryMissingError);expect(h.broker.pools.live()).toEqual([]);h.setAlpha(255);const image=await h.load();expect(image.pages[0][0][3]).toBe(255);image.close();}finally{h.dispose();}
  });
  for(const end of ["abort","generation","dispose"] as const)it(`${end} holds encoded copies and prospective native pixels until late worker decode settles`,async()=>{
    const h=atlasWorkerHost(), gate=deferredWorker<void>(), controller=new AbortController();h.nativeWait(gate.promise);const work=h.load(controller.signal),result=work.catch((error:unknown)=>error);
    await flushWorker();expect(h.requests[0]?.kind).toBe("decode");expect(h.broker.pools.stats().decoded.reserved).toBe(256*256*4);expect(h.broker.pools.stats().encoded.reserved).toBe(h.png.length*3);
    if(end==="abort")controller.abort();else if(end==="generation")h.broker.invalidate();else h.dispose();
    expect(h.nativeCloses).not.toHaveBeenCalled();expect(h.broker.pools.stats().decoded.reserved).toBe(256*256*4);gate.resolve();const error=await result;
    expect(error).toBeInstanceOf(Error);expect(error).not.toBeInstanceOf(ImageryMissingError);expect(h.nativeCloses).toHaveBeenCalledOnce();expect(h.broker.pools.live()).toEqual([]);h.dispose();
  });
  it("keeps a failed canvas charged through an actual late retirement message and still retires every other input",async()=>{
    const h=atlasWorkerHost(),proof=deferredWorker<void>();h.surfaceFailure(new Error("canvas reset failed"),proof.promise);
    try{const error=await h.load().catch((error:unknown)=>error);expect(error).toBeInstanceOf(Error);expect(error).not.toBeInstanceOf(ImageryMissingError);expect(h.broker.pools.stats().decoded.reserved).toBe(256*256*4);expect(h.nativeCloses).toHaveBeenCalledOnce();proof.resolve();await flushWorker();expect(h.broker.pools.live()).toEqual([]);}finally{h.dispose();}
  });
  it("quarantines unknown postMessage failure until the supplied actual realm retirement proof",async()=>{
    const h=atlasWorkerHost(),reason=new Error("postMessage completion unknown");h.postFailure(reason);let settled=false;const work=h.load().finally(()=>{settled=true;}),result=work.catch((error:unknown)=>error);
    await flushWorker();expect(settled).toBe(false);expect(h.broker.pools.stats().decoded.reserved).toBe(256*256*4);expect(h.broker.pools.stats().encoded.reserved).toBe(h.png.length*3);
    h.retired.resolve();expect(await result).toBeInstanceOf(Error);expect(h.broker.pools.live()).toEqual([]);expect(h.loader.offThread).toBe(false);h.dispose();
  });
  it("rejects malformed worker mip structure without classifying it missing",async()=>{
    const h=atlasWorkerHost();h.changeReply(reply=>reply.kind==="prepared"?{...reply,pages:[[]]}:reply);
    try{const error=await h.load().catch((error:unknown)=>error);expect(error).toBeInstanceOf(Error);expect(error).not.toBeInstanceOf(ImageryMissingError);expect(h.broker.pools.live()).toEqual([]);}finally{h.dispose();}
  });
  it("refuses complete preparation capacity before posting a worker bitmap or allocating pages",async()=>{
    const h=atlasWorkerHost();h.broker.pools.setLimits({...h.broker.pools.limits(),decoded:pageUploadBytes()+256*256*4});
    try{await expect(h.load()).rejects.toThrow();expect(h.requests.map(request=>request.kind)).toEqual(["decode"]);expect(h.createSurface).not.toHaveBeenCalled();expect(h.nativeCloses).toHaveBeenCalledOnce();expect(h.broker.pools.live()).toEqual([]);}finally{h.dispose();}
  });
});
