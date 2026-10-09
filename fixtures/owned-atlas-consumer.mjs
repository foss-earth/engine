/** Source prepared installed consumer: actual public broker/Renderer/Atlas;
 * supplied CPU native queue and texture boundaries, no GPU qualification. */
import assert from 'node:assert/strict';
import { Constants } from '@babylonjs/core';
import { createImageSessionBroker, ResourceCapacityError } from '@foss-earth/images';
import { createTextureDevicePorts, createTextureTransferTracker } from '@foss-earth/renderer/babylon';
import { createImageryAtlas } from '@foss-earth/engine/babylon';
import { createImageryResidency, planAtlasLayout, pageUploadBytes, preparePages } from '@foss-earth/engine/imagery';
// A complete minimum24page Atlas is24 *441936 bytes plus transactional tables.
const FIXTURE_ATLAS_GPU_BYTES=12*2**20;
const broker=createImageSessionBroker({requests:1,decodes:1,pools:{sourceGpu:64*2**20,overlap:32*2**20,encoded:1000,decoded:16*2**20,uploadOutstanding:8*2**20}});
let complete, calls=0, surfaces=0;
const native={isWebGPU:true,getCaps:()=>({maxTextureSize:8192}),_device:{queue:{onSubmittedWorkDone:()=>new Promise(resolve=>{complete=resolve;})}},updateTextureData(){calls++;}};
const scene={getEngine:()=>native};
const grant=(pool,bytes,label,options={})=>{const result=broker.pools.reserve(pool,bytes,label,options);return result.ok?result.reservation:null;};
const tracker=createTextureTransferTracker({scene,admit:(bytes,label)=>grant('uploadOutstanding',bytes,label),requestRender(){}});
const device=createTextureDevicePorts({scene,transfer:tracker.transfer,tryAdmit:tracker.tryAdmit});
device.createRawTexture=options=>{assert.equal(options.data,null);surfaces++;return{name:'',getInternalTexture:()=>({getEngine:()=>native,isCube:false,width:options.width,height:options.height,format:Constants.TEXTUREFORMAT_RGBA,type:Constants.TEXTURETYPE_UNSIGNED_BYTE}),dispose(){surfaces--;}};};
const resources={generation:()=>broker.generation(),reserveGpu:(bytes,label,options)=>grant('sourceGpu',bytes,label,options),reserveTable:(bytes,label)=>grant('decoded',bytes,label),
  reserveCopy(bytes,label){const result=broker.pools.reserve('decoded',bytes,label);if(!result.ok)throw new ResourceCapacityError(result.pool,result.reason);return result.reservation;},
  canUpload:(bytes,extra=0)=>broker.pools.fits('uploadOutstanding',bytes)&&broker.pools.fits('decoded',bytes+extra),subscribeAvailable:listener=>broker.pools.subscribeAvailable(listener),
  capacityKey:()=>JSON.stringify(Object.entries(broker.pools.stats()).map(([key,row])=>[key,row.limit,row.reserved]))};
const layout=planAtlasLayout({maxBytes:FIXTURE_ATLAS_GPU_BYTES,maxTextureSize:8192,powerOfTwo:false,maxPatches:2});
assert(layout, 'Fixture budget must fit the complete minimum Atlas.');
const atlas=createImageryAtlas(scene,layout,1,device,{...resources,overlap:false,requestRender(){},onError(error){throw error;}});
const prepared=grant('decoded',pageUploadBytes(),'consumer prepared pages');let closing=false;
const image={width:256,height:256,compressedBytes:1,pages:preparePages(new Uint8Array(256*256*4).fill(27),256,256),isCurrent:()=>!closing,
  close(){if(closing)return;closing=true;prepared.release();},retain(){assert.equal(closing,false);return prepared.retain();}};
const residency=createImageryResidency({store:atlas,loader:{load:async()=>image},now:()=>0,createAbortController:()=>new AbortController(),
  limits:{gpuBytes:FIXTURE_ATLAS_GPU_BYTES,stagingBytes:16*2**20,concurrentRequests:1,queuedRequests:1,uploadBytesPerUpdate:8*2**20,cpuMsPerUpdate:2,missingRetryMs:1000,retryDelayMs:{min:2000,max:30000}}});
try{
  residency.setDemand([{imageKey:'page',sourceKey:'source@1',url:'https://fixture.invalid/page',width:256,height:256,priority:8,coverage:true}]);residency.pump();for(let i=0;i<12;i++)await Promise.resolve();
  assert.equal(residency.upload(Infinity),441936);assert.equal(calls,5);assert.equal(residency.stats().resident,0);assert.equal(residency.stats().uploading,1);
  assert.equal(broker.pools.stats().decoded.reserved,2*441936);assert.equal(broker.pools.stats().uploadOutstanding.reserved,441936);
  complete();for(let i=0;i<12;i++)await Promise.resolve();assert.equal(residency.stats().resident,1);assert.equal(residency.stats().uploads,1);assert.equal(broker.pools.stats().decoded.reserved,0);
  residency.dispose();atlas.dispose();await atlas.whenDisposed;assert.equal(surfaces,0);assert.deepEqual(broker.pools.live(),[]);
  console.log('Installed actual managed Atlas/Renderer/common broker completion contract composed; CPU native boundaries only.');
}finally{residency.dispose();tracker.deviceLost();atlas.dispose();tracker.dispose();broker.dispose();}
