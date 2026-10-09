import { describe, expect, it, vi } from "vitest";
import { createImageSessionBroker } from "@foss-earth/images";
import { createImageFileService } from "@foss-earth/images/browser";
import { createBoundedAtlasImageryLoader } from "../src/browser/boundedAtlasImageryLoader.js";
import { createImageryResidency, ImageryOwnedUploadUnsupportedError, type ImageryRequest, type ImageryLoader,
  type PreparedImage, type RetainedPreparedImage } from "../src/terrain/imagery/imageryResidency.js";

const request = (key: string, extra: Partial<ImageryRequest> = {}): ImageryRequest => ({ imageKey: key, url: `https://fixture.invalid/${key}`, width: 256, height: 256, priority: 7, coverage: false, sourceKey: "s@1", ...extra });
function deferred<T>() { let resolve!:(value:T)=>void; const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve}; }
async function flush() { for(let i=0;i<6;i++) await Promise.resolve(); }
function harness() {
  const broker = createImageSessionBroker({ requests: 1, decodes: 1, pools: { encoded: 1000, decoded: 2_000_000, sourceGpu: 0, overlap: 0, uploadOutstanding: 0 } });
  const pending: { resolve(image:PreparedImage):void; signal:AbortSignal }[] = [];
  const loader: ImageryLoader<AbortSignal> = { load: vi.fn((_url:string,_expected:{width:number;height:number},signal:AbortSignal) => new Promise<PreparedImage>(resolve=>{pending.push({resolve,signal});})) };
  const allocate = vi.fn(() => 0), upload = vi.fn(), release = vi.fn(), onError = vi.fn(), onChange = vi.fn();
  let now = 0;
  const limits = { gpuBytes: 1e9, stagingBytes: 1e9, concurrentRequests: 8, queuedRequests: 100, uploadBytesPerUpdate: 1e9, cpuMsPerUpdate: 2,
    missingRetryMs: 1000, retryDelayMs: { min: 2000, max: 30000 } };
  const residency = createImageryResidency({ loader, store: { capacity: 8, allocate, upload, release }, limits,
    now:()=>now, createAbortController:()=>new AbortController(), onError, onChange });
  const image = (width=256):RetainedPreparedImage => {
    const grant=broker.pools.reserve("decoded",1000,"prepared fixture pages"); if(!grant.ok)throw new Error(grant.reason);
    let closing=false;
    return { width,height:width,pages:[[new Uint8Array(1000)]],compressedBytes:12,
      close:vi.fn(()=>{closing=true;grant.reservation.release();}), retain:()=>grant.reservation.retain(),isCurrent:()=>!closing };
  };
  return {broker,pending,loader,residency,image,allocate,upload,release,onError,onChange,advance:(ms:number)=>{now+=ms;},limits};
}
describe("actual residency prepared-input retirement",()=>{
  it("forwards priority and refuses managed pages before any slot allocation or legacy upload, then uses existing retry",async()=>{
    const f=harness(); f.residency.setDemand([request("a")]);f.residency.pump();
    expect(f.loader.load).toHaveBeenCalledWith("https://fixture.invalid/a",{width:256,height:256},f.pending[0].signal,7);
    const image=f.image();f.pending[0].resolve(image);await flush();
    expect(f.residency.stats().stagedBytes).toBe(1000);expect(f.residency.upload(Infinity)).toBe(0);
    expect(f.allocate).not.toHaveBeenCalled();expect(f.upload).not.toHaveBeenCalled();expect(f.release).not.toHaveBeenCalled();
    expect(image.close).toHaveBeenCalledOnce();expect(f.onError.mock.calls[0][0]).toBeInstanceOf(ImageryOwnedUploadUnsupportedError);
    expect(f.residency.stats()).toMatchObject({failed:1,staged:0,stagedBytes:0});expect(f.residency.isMissing("a")).toBe(false);
    expect(f.residency.nextWakeAt()).toBe(2000);expect(f.broker.pools.live()).toEqual([]);
    f.residency.pump();expect(f.pending).toHaveLength(1);f.advance(2000);f.residency.pump();expect(f.pending).toHaveLength(2);
    f.residency.dispose();f.broker.dispose();
  });
  it("closes source-switch and disposed late answers without reviving residency",async()=>{
    const f=harness();f.residency.setDemand([request("a")]);f.residency.pump();
    f.residency.setDemand([request("b",{sourceKey:"s@2"})]);f.residency.pump();expect(f.pending[0].signal.aborted).toBe(true);
    const a=f.image();f.pending[0].resolve(a);await flush();expect(a.close).toHaveBeenCalledOnce();
    f.residency.dispose();const b=f.image();f.pending[1].resolve(b);await flush();expect(b.close).toHaveBeenCalledOnce();
    expect(f.residency.stats()).toMatchObject({resident:0,staged:0,inFlight:0});expect(f.broker.pools.live()).toEqual([]);f.broker.dispose();
  });
  it("closes wrong-size and no-demand completions while preserving missing and admission wake semantics",async()=>{
    const f=harness();f.residency.setDemand([request("wrong")]);f.residency.pump();
    const wrong=f.image(512);f.pending[0].resolve(wrong);await flush();expect(wrong.close).toHaveBeenCalledOnce();expect(f.residency.isMissing("wrong")).toBe(true);
    f.residency.setDemand([request("old")]);f.residency.pump();f.residency.setDemand([request("new")]);
    const old=f.image(),calls=f.onChange.mock.calls.length;f.pending[1].resolve(old);await flush();
    expect(old.close).toHaveBeenCalledOnce();expect(f.onChange.mock.calls.length).toBeGreaterThan(calls);
    expect(f.broker.pools.live()).toEqual([]);f.residency.dispose();f.broker.dispose();
  });
  for(const action of ["drop","reset","dispose"] as const) {
    it(`${action} retires staged state and its charge before invoking the supplied close`,async()=>{
      const f=harness();f.residency.setDemand([request("a")]);f.residency.pump();const image=f.image(),close=image.close;
      image.close=vi.fn(()=>{expect(f.residency.stats().stagedBytes).toBe(0);close();});
      f.pending[0].resolve(image);await flush();
      if(action==="drop")f.residency.setDemand([]);else if(action==="reset")f.residency.reset();else f.residency.dispose();
      expect(image.close).toHaveBeenCalledOnce();expect(f.broker.pools.live()).toEqual([]);f.residency.dispose();f.broker.dispose();
    });
  }
  for(const action of ["reset","dispose"] as const) {
    it(`${action} attempts every prepared close even when the first throws`,async()=>{
      const f=harness();f.residency.setDemand([request("a"),request("b")]);f.residency.pump();const a=f.image(),b=f.image(),close=a.close;
      a.close=vi.fn(()=>{close();throw new Error("prepared close failure");});f.pending[0].resolve(a);f.pending[1].resolve(b);await flush();
      expect(()=>f.residency[action]()).toThrow("prepared close failure");expect(a.close).toHaveBeenCalledOnce();expect(b.close).toHaveBeenCalledOnce();
      expect(f.residency.stats()).toMatchObject({staged:0,stagedBytes:0});expect(f.broker.pools.live()).toEqual([]);f.residency.dispose();f.broker.dispose();
    });
  }
  it("drops every obsolete staged input after retiring identities even when the first close throws",async()=>{
    const f=harness();f.residency.setDemand([request("a"),request("b")]);f.residency.pump();const a=f.image(),b=f.image(),close=a.close;
    a.close=vi.fn(()=>{expect(f.residency.stats().stagedBytes).toBe(0);close();throw new Error("first close failure");});
    f.pending[0].resolve(a);f.pending[1].resolve(b);await flush();
    expect(()=>f.residency.setDemand([request("new")])).toThrow("first close failure");
    expect(a.close).toHaveBeenCalledOnce();expect(b.close).toHaveBeenCalledOnce();expect(f.residency.stats()).toMatchObject({staged:0,queued:1});
    expect(f.broker.pools.live()).toEqual([]);f.residency.dispose();f.broker.dispose();
  });
  it("does not reopen admission when a prepared close reenters demand during disposal",async()=>{
    const f=harness();f.residency.setDemand([request("a")]);f.residency.pump();const a=f.image(),close=a.close;
    a.close=vi.fn(()=>{close();f.residency.setDemand([request("new")]);});f.pending[0].resolve(a);await flush();f.residency.dispose();
    expect(a.close).toHaveBeenCalledOnce();expect(f.residency.stats()).toMatchObject({staged:0,queued:0,inFlight:0});
    f.residency.pump();expect(f.pending).toHaveLength(1);expect(f.broker.pools.live()).toEqual([]);f.broker.dispose();
  });
  it("preserves unsupported-upload and cleanup errors while retiring state even when error reporting throws",async()=>{
    const f=harness();f.residency.setDemand([request("a")]);f.residency.pump();const image=f.image(),close=image.close;
    image.close=vi.fn(()=>{close();throw new Error("close failure");});f.pending[0].resolve(image);await flush();
    f.onError.mockImplementationOnce(()=>{throw new Error("reporting failure");});
    expect(()=>f.residency.upload(Infinity)).toThrow("reporting failure");
    const error=f.onError.mock.calls[0][0] as AggregateError;expect(error.errors[0]).toBeInstanceOf(ImageryOwnedUploadUnsupportedError);expect(error.errors[1].message).toBe("close failure");
    expect(f.residency.stats()).toMatchObject({failed:1,staged:0,stagedBytes:0});expect(f.broker.pools.live()).toEqual([]);f.residency.dispose();f.broker.dispose();
  });
  it("rejects partial ownership contracts and closes a staged refresh failure through the actual error path",async()=>{
    const f=harness();f.residency.setDemand([request("partial")]);f.residency.pump();const partial=f.image();delete (partial as PreparedImage).retain;
    f.pending[0].resolve(partial);await flush();expect(partial.close).toHaveBeenCalledOnce();expect(f.residency.stats().failed).toBe(1);
    f.residency.setDemand([request("observer")]);f.residency.pump();const observer=f.image();f.onChange.mockImplementationOnce(()=>{throw new Error("refresh failure");});
    f.pending[1].resolve(observer);await flush();expect(observer.close).toHaveBeenCalledOnce();expect(f.residency.stats().failed).toBe(1);
    expect(f.broker.pools.live()).toEqual([]);f.residency.dispose();f.broker.dispose();
  });
  it("refuses actual common-produced pages on the real legacy store boundary and releases their exact charge",async()=>{
    const f=harness();const bytes=new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,1,0,0,0,1,0,8,6,0,0,0,0,0,0,0]);
    const files=createImageFileService({broker:f.broker,fetch:async()=>new Response(bytes),decode:async()=>({width:256,height:256,close(){}} as ImageBitmap),priority:()=>0,limits:()=>({responseBytes:1000,timeoutMs:1000})});
    const producer=createBoundedAtlasImageryLoader({broker:f.broker,files,describe:()=>({declaredBytes:bytes.length}),priority:()=>0,createSurface:()=>({read(){const data=new Uint8ClampedArray(256*256*4);data[3]=255;return data;},dispose(){}})});
    const loaded=deferred<void>();f.loader.load=(_url,expected,signal,priority)=>producer.load(_url,expected,signal,priority).then(image=>{loaded.resolve();return image;});
    f.residency.setDemand([request("real")]);f.residency.pump();await loaded.promise;await flush();
    expect(f.broker.pools.stats().decoded.reserved).toBeGreaterThan(0);expect(f.residency.upload(Infinity)).toBe(0);
    expect(f.allocate).not.toHaveBeenCalled();expect(f.upload).not.toHaveBeenCalled();expect(f.broker.pools.live()).toEqual([]);
    f.residency.dispose();producer.dispose();f.broker.dispose();
  });
});
