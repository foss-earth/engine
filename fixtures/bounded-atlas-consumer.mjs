/** Prepared public installed consumer; actual common service with supplied CPU
 * native surfaces. No browser decoder/GPU/worker/provider qualification. */
import assert from 'node:assert/strict';
import { createImageSessionBroker } from '@foss-earth/images';
import { createImageFileService } from '@foss-earth/images/browser';
import { createBoundedAtlasImageryLoader } from '@foss-earth/engine/browser';
import { createImageryResidency, ImageryOwnedUploadUnsupportedError, pageUploadBytes } from '@foss-earth/engine/imagery';
const bytes=new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,1,0,0,0,1,0,8,6,0,0,0,0,0,0,0]);
const broker=createImageSessionBroker({requests:1,decodes:1,pools:{encoded:1000,decoded:2_000_000,sourceGpu:0,overlap:0,uploadOutstanding:0}});
let bitmapCloses=0,surfaceCloses=0,allocations=0,uploads=0,resolveLoaded;
const files=createImageFileService({broker,fetch:async()=>new Response(bytes),decode:async()=>({width:256,height:256,close(){bitmapCloses++;}}),priority:()=>0,limits:()=>({responseBytes:1000,timeoutMs:1000})});
const options={broker,files,describe(){assert.equal(this,options);return{declaredBytes:1};},priority:()=>0,
  createSurface:()=>({read(){const data=new Uint8ClampedArray(256*256*4);for(let i=3;i<data.length;i+=4)data[i]=255;return data;},dispose(){surfaceCloses++;}})};
const loader=createBoundedAtlasImageryLoader(options);
let residency;
try {
  const image=await loader.load('https://fixture.invalid/map',{width:256,height:256},new AbortController().signal,4);
  assert.equal(image.compressedBytes,bytes.length);assert.equal(loader.offThread,false);assert.equal(broker.pools.stats().decoded.reserved,pageUploadBytes());
  const end=image.retain();broker.invalidate();assert.equal(image.isCurrent(),false);assert.equal(image.pages[0][0][3],255);end();assert.deepEqual(broker.pools.live(),[]);
  const ready=new Promise(resolve=>{resolveLoaded=resolve;});let reported;
  residency=createImageryResidency({loader:{load(...args){return loader.load(...args).then(image=>{resolveLoaded();return image;});}},
    store:{capacity:8,allocate(){allocations++;return 0;},release(){},upload(){uploads++;}},createAbortController:()=>new AbortController(),now:()=>0,
    limits:{gpuBytes:1e9,stagingBytes:1e9,concurrentRequests:1,queuedRequests:1,uploadBytesPerUpdate:1e9,cpuMsPerUpdate:2,missingRetryMs:1000,retryDelayMs:{min:2000,max:30000}},onError(error){reported=error;}});
  residency.setDemand([{imageKey:'tile',url:'https://fixture.invalid/tile',width:256,height:256,priority:9,coverage:false,sourceKey:'s@1'}]);residency.pump();await ready;for(let i=0;i<6;i++)await Promise.resolve();
  assert.equal(residency.upload(Infinity),0);assert(reported instanceof ImageryOwnedUploadUnsupportedError);assert.equal(allocations,0);assert.equal(uploads,0);assert.equal(residency.nextWakeAt(),2000);
  assert.deepEqual(broker.pools.live(),[]);assert.equal(bitmapCloses,2);assert.equal(surfaceCloses,2);
  console.log('Installed bounded Atlas page producer/common ownership composed; owned native upload explicitly unsupported.');
} finally {residency?.dispose();loader.dispose();broker.dispose();}
