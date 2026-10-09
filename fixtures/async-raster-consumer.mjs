/** Source-prepared installed public consumer. CPU native pixel/upload doubles
 * qualify API composition only; no browser/GPU/readiness measurement is claimed. */
import assert from 'node:assert/strict';
import { NullEngine, Scene, Texture } from '@babylonjs/core';
import { createSettingsRegistry } from '@foss-earth/ui/settings';
import { RENDERER_PARAMETERS } from '@foss-earth/renderer/settings';
import { createTextureDevicePorts } from '@foss-earth/renderer/babylon';
import { createImageSessionBroker } from '@foss-earth/images';
import { createImageFileService } from '@foss-earth/images/browser';
import { createRasterTilesRuntime, createBoundedMapTextureLoader } from '@foss-earth/engine/babylon';
import { RASTER_BASE_MAP_SOURCES } from '@foss-earth/engine/core';
import { CONTROLS_PARAMETERS, MAP_SOURCE_PARAMETERS, MAP_DETAIL_PARAMETERS, MAP_LOADING_PARAMETERS, MAP_SELECTION_PARAMETERS, MAP_TERRAIN_SELECTION_PARAMETERS, MAP_AUTO_PARAMETERS } from '@foss-earth/engine/settings';
const png = new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,2,0,0,0,1,8,6,0,0,0,0,0,0,0]);
const engine = new NullEngine(), scene = new Scene(engine); engine.getCaps().maxTextureSize = 8192;
const settings = createSettingsRegistry({ storage: null }); settings.register([...CONTROLS_PARAMETERS,...MAP_SOURCE_PARAMETERS,...MAP_DETAIL_PARAMETERS,...MAP_LOADING_PARAMETERS,...MAP_SELECTION_PARAMETERS,...MAP_TERRAIN_SELECTION_PARAMETERS,...MAP_AUTO_PARAMETERS,...RENDERER_PARAMETERS]);
const broker = createImageSessionBroker({ pools: { encoded: 2**20, decoded: 2**20, sourceGpu: 2**20, overlap: 2**20, uploadOutstanding: 2**20 }, requests: 6, decodes: 6 });
const files = createImageFileService({ broker, limits: () => ({responseBytes:1024,timeoutMs:1000}), priority: () => 1,
  fetch: async () => new Response(png,{headers:{'content-type':'image/png'}}), decode: async () => ({width:2,height:1,close(){}}) });
let transfers = 0, runtime; const nowMs = 0;
const uploader = { async upload(request) {
  assert.deepEqual(request.textureColor,{useSRGBBuffer:false,gammaSpace:true}); const ticket = request.reserveUpload(8,'CPU map fixture transfer');
  try { const texture = new Texture(null,scene); transfers++; return {kind:'2d',texture,width:2,height:1,levels:2,gpuBytes:12,complete:true,dispose(){texture.dispose();}}; }
  finally { ticket.release(); }
} };
const acquire = createBoundedMapTextureLoader({ broker, files, uploader, maxTextureSide: () => 256, whenReady: async () => {} });
const timers = new Set(); let metadataCalls = 0;
try {
  runtime = createRasterTilesRuntime({ scene, settings, source: {...RASTER_BASE_MAP_SOURCES[0],tileSize:{width:2,height:1}}, nowMs: () => nowMs,
    after(callback){timers.add(callback);return()=>timers.delete(callback);}, requestRender(){}, meshRebuildCpuMs:()=>2,
    asyncMapTextures:{resolve(source,tile,url){assert(source.id);assert(Number.isInteger(tile.z));metadataCalls++;return{file:{url,mimeType:'image/png',width:2,height:1},declaredBytes:png.length,priority:3};},acquire,createAbortController:()=>new AbortController()},
    attachTerrainLighting:()=>({}), createTerrainLoader:()=>({load:()=>new Promise(()=>{}),loadPatch:()=>new Promise(()=>{}),dispose(){},setPaused(){},getMetrics:()=>({active:0,queued:0,decodedBytes:0})}),
    imageryPorts:{device:createTextureDevicePorts({scene,transfer:(_bytes,_label,submit)=>submit()}),capabilities:{backend:'webgl2',maxTextureSize:8192,explicitGradients:true},createAbortController:()=>new AbortController(),loader:{load(){throw new Error('No atlas selected.');}}},log:{warn(){}},
  });
  runtime.update(); for(let i=0;i<120;i++) await Promise.resolve(); runtime.update();
  assert(metadataCalls>0);assert.equal(transfers,metadataCalls);assert(runtime.getMetrics().visibleTiles>0);
  const revision=runtime.getRevision();runtime.setSource({...RASTER_BASE_MAP_SOURCES[0],id:'public-async-replacement',tileSize:{width:2,height:1},urlTemplate:'https://fixture.invalid/replacement/{z}/{x}/{y}'});
  for(let i=0;i<120;i++) await Promise.resolve();runtime.update();assert.equal(runtime.getRevision(),revision);
  runtime.dispose();runtime.dispose();assert.equal(scene.meshes.length,0);assert.deepEqual(broker.pools.live(),[]);assert.equal(engine.isDisposed,false);
  console.log('Installed async raster/common-service lifetime API composed with CPU native doubles; no GPU qualification.');
} finally {runtime?.dispose();broker.dispose();scene.dispose();engine.dispose();}
