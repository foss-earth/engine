/** Explicit CPU native/message boundaries; public common service and real Engine kernel. */
import { vi } from "vitest";
import { createImageSessionBroker } from "@foss-earth/images";
import { createAtlasImageryWorkerBridge } from "../../src/browser/atlasImageryWorkerBridge.js";
import { installAtlasImageryWorkerKernel } from "../../src/browser/atlasImageryWorkerKernel.js";
import type { AtlasImageryWorkerPort, AtlasImageryWorkerReply, AtlasImageryWorkerRequest, AtlasImageryWorkerScope } from "../../src/browser/atlasImageryWorkerProtocol.js";
import { createBoundedAtlasImageryLoader } from "../../src/browser/boundedAtlasImageryLoader.js";
import type { RgbaReadbackSurface } from "@foss-earth/images/browser";
import type { ComputeAdmissionPort } from "../../src/browser/computeAdmission.js";
export function deferredWorker<T>() { let resolve!: (value: T) => void; const promise=new Promise<T>(done=>{resolve=done;});return{promise,resolve}; }
export async function flushWorker(): Promise<void> { for(let index=0;index<16;index++)await Promise.resolve(); }
export function atlasWorkerHost(available=true, compute?: ComputeAdmissionPort) {
  const broker=createImageSessionBroker({requests:1,decodes:1,pools:{encoded:2000,decoded:4_000_000,sourceGpu:0,overlap:0,uploadOutstanding:0}});
  const nativeCloses=vi.fn(), surfaceCloses=vi.fn(), onError=vi.fn(), retired=deferredWorker<void>();
  let nativeGate: Promise<void>|null=null, alpha=255, surfaceRetired: Promise<void>|undefined, surfaceError:unknown, postError:unknown, alterReply:((reply:AtlasImageryWorkerReply)=>AtlasImageryWorkerReply)|undefined;
  const makeBitmap=(width=256,height=256):ImageBitmap=>{const owned={width,height,close(){if(owned.width&&owned.height)nativeCloses();owned.width=owned.height=0;}};return owned as unknown as ImageBitmap;};
  const moveBitmap=(bitmap:ImageBitmap):ImageBitmap=>{const moved=makeBitmap(bitmap.width,bitmap.height);Object.assign(bitmap,{width:0,height:0});return moved;};
  const decode=vi.fn(async()=>{if(nativeGate)await nativeGate;return makeBitmap();});
  const pixels=()=>{const data=new Uint8ClampedArray(256*256*4);for(let index=3;index<data.length;index+=4)data[index]=alpha;return data;};
  const createSurface=vi.fn((_width:number,_height:number):RgbaReadbackSurface=>{void _width;void _height;return{read:async()=>pixels(),dispose(){surfaceCloses();if(surfaceError)throw surfaceError;},...(surfaceRetired?{retired:surfaceRetired}:{})};});
  const requests: AtlasImageryWorkerRequest[]=[], replies: AtlasImageryWorkerReply[]=[];
  const scope:AtlasImageryWorkerScope={onmessage:null,postMessage(reply,transfer=[]){
    let moved:AtlasImageryWorkerReply;
    if(reply.kind==="decoded")moved={...reply,bitmap:moveBitmap(reply.bitmap)};
    else moved=structuredClone(reply,{transfer});
    if(alterReply)moved=alterReply(moved);
    replies.push(moved);queueMicrotask(()=>worker.onmessage?.({data:moved} as MessageEvent<AtlasImageryWorkerReply>));
  }};
  const kernel=installAtlasImageryWorkerKernel({scope,decode,createSurface,onError});
  const worker:AtlasImageryWorkerPort={compute,onmessage:null,onerror:null,retired:retired.promise,terminate:vi.fn(()=>kernel.dispose()),postMessage(request,transfer){
    if(postError)throw postError;
    const moved=request.kind==="decode"?structuredClone(request,{transfer}):{...request,bitmap:moveBitmap(request.bitmap)};
    requests.push(moved);queueMicrotask(()=>scope.onmessage?.({data:moved} as MessageEvent<AtlasImageryWorkerRequest>));
  }};
  const bridge=createAtlasImageryWorkerBridge({broker,createWorker:()=>available?worker:null,decode,onError});
  const png=new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,1,0,0,0,1,0,8,6,0,0,0,0,0,0,0]);
  const files=bridge.createFileService({fetch:async()=>new Response(png,{headers:{"content-type":"image/png"}}),priority:()=>0,limits:()=>({responseBytes:1000,timeoutMs:1000})});
  const loader=createBoundedAtlasImageryLoader({broker,files,worker:bridge,describe:()=>({declaredBytes:1}),priority:()=>0,createSurface});
  return{broker,files,bridge,loader,worker,kernel,requests,replies,decode,createSurface,nativeCloses,surfaceCloses,onError,png,retired,
    load:(signal=new AbortController().signal)=>loader.load("https://fixture.invalid/worker",{width:256,height:256},signal),
    nativeWait(promise:Promise<void>){nativeGate=promise;},setAlpha(value:number){alpha=value;},surfaceFailure(error:unknown,proof?:Promise<void>){surfaceError=error;surfaceRetired=proof;},postFailure(error:unknown){postError=error;},changeReply(transform:(reply:AtlasImageryWorkerReply)=>AtlasImageryWorkerReply){alterReply=transform;},
    dispose(){loader.dispose();bridge.dispose();broker.dispose();}};
}
