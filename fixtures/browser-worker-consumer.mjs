/** Installed public exports with same-broker CPU message transport; UNRUN.
 * The transport moves private encoded/page buffers and simulates bitmap moves.
 * This does not qualify a browser worker, decoder, WebP backend or GPU. */
import assert from 'node:assert/strict';
import { createImageSessionBroker } from '@foss-earth/images';
import { createTerrainImageDecoder, createAtlasImageryWorkerBridge, installAtlasImageryWorkerKernel,
  createBoundedAtlasImageryLoader } from '@foss-earth/engine/browser';
import { TERRAIN_IMAGE_DECODE_PARAMETERS, POSITION_GEOID_PARAMETERS,
  POSITION_SEA_LEVEL_GRID_ID } from '@foss-earth/engine/settings';
import { pageUploadBytes } from '@foss-earth/engine/imagery';
assert.equal(TERRAIN_IMAGE_DECODE_PARAMETERS[0].default,1024);
assert(POSITION_GEOID_PARAMETERS.some(parameter=>parameter.id===POSITION_SEA_LEVEL_GRID_ID&&parameter.default==='15'));
let terrainClosed=0,optionsSeen;
const terrain=createTerrainImageDecoder({limits:()=>({maxTileSide:1024}),nowMs:()=>0,
  createImageBitmap:async(blob,options)=>{assert.equal(blob.type,'image/webp');optionsSeen=options;return{width:1,height:1,close(){terrainClosed++;}};},
  createCanvas:()=>({width:1,height:1,getContext:()=>({drawImage(){},getImageData:()=>({data:new Uint8ClampedArray([127,255,128,255])})})})});
assert.equal((await terrain(new Blob([new Uint8Array([1])],{type:'image/webp'}))).heights[0],-.5);
assert.deepEqual(optionsSeen,{colorSpaceConversion:'none',premultiplyAlpha:'none'});assert.equal(terrainClosed,1);
const broker=createImageSessionBroker({requests:1,decodes:1,pools:{encoded:2000,decoded:4_000_000,sourceGpu:0,overlap:0,uploadOutstanding:0}});
let bitmapClosed=0,surfaceClosed=0,terminated=0;
const bitmap=(width=256,height=256)=>({width,height,close(){if(this.width&&this.height)bitmapClosed++;this.width=this.height=0;}});
const move=input=>{const output=bitmap(input.width,input.height);input.width=input.height=0;return output;};
const pixels=()=>{const data=new Uint8ClampedArray(256*256*4);for(let index=3;index<data.length;index+=4)data[index]=255;return data;};
const createSurface=()=>({read:async()=>pixels(),dispose(){surfaceClosed++;}});
const requests=[];
const scope={onmessage:null,postMessage(reply,transfer=[]){const moved=reply.kind==='decoded'?{...reply,bitmap:move(reply.bitmap)}:structuredClone(reply,{transfer});queueMicrotask(()=>worker.onmessage?.({data:moved}));}};
const kernel=installAtlasImageryWorkerKernel({scope,decode:async()=>bitmap(),createSurface,onError(error){throw error;}});
const worker={onmessage:null,onerror:null,terminate(){terminated++;kernel.dispose();},postMessage(request,transfer){const moved=request.kind==='decode'?structuredClone(request,{transfer}):{...request,bitmap:move(request.bitmap)};requests.push(moved.kind);queueMicrotask(()=>scope.onmessage?.({data:moved}));}};
const bridge=createAtlasImageryWorkerBridge({broker,createWorker:()=>worker,decode:async()=>bitmap(),onError(error){throw error;}});
const source=new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,1,0,0,0,1,0,8,6,0,0,0,0,0,0,0]),before=source.slice();
const files=bridge.createFileService({fetch:async()=>new Response(source,{headers:{'content-type':'image/png'}}),priority:()=>0,limits:()=>({responseBytes:1000,timeoutMs:1000})});
const loader=createBoundedAtlasImageryLoader({broker,files,worker:bridge,describe:()=>({declaredBytes:1}),priority:()=>0,createSurface});
try {
  assert.equal(loader.offThread,true);const image=await loader.load('https://fixture.invalid/worker',{width:256,height:256},new AbortController().signal,4);
  assert.deepEqual(requests,['decode','prepare']);assert.deepEqual(source,before);assert.equal(bitmapClosed,1);assert.equal(surfaceClosed,1);
  assert.equal(image.pages[0].length,5);assert.equal(image.pages[0][0][3],255);assert.equal(broker.pools.stats().decoded.reserved,pageUploadBytes());
  const end=image.retain();image.close();assert.equal(image.pages[0][0][3],255);end();assert.deepEqual(broker.pools.live(),[]);
  loader.dispose();bridge.dispose();assert.equal(terminated,1);assert.equal(bridge.offThread,false);
  console.log('Public DEM raw RGB seam and same-broker worker kernel/decode/preparation buffer transport composed with CPU ports.');
} finally {loader.dispose();bridge.dispose();broker.dispose();}
