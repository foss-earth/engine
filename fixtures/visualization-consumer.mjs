/** Standalone installed consumer; source paths are never read/imported. */
import assert from "node:assert/strict";
const names=["window","document","navigator","ImageBitmap","OffscreenCanvas","HTMLCanvasElement"],previous=names.map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]);
try {
  for(const name of names)Object.defineProperty(globalThis,name,{configurable:true,get(){throw new Error(`PURE_ENGINE_TOUCHED_${name}`);}});
  const core=await import("@foss-earth/engine"),pure=await import("@foss-earth/engine/visualization");
  assert.equal(core.DEFAULT_POI_SPRITE_SIZE_PARAMS.minSize,200);assert.equal(pure.DEFAULT_ORBIT_COMPASS_SCALE_PARAMS.radiusScale,.035);assert.equal(pure.poiRefinementLod(5000),17);
  const culling=core.createHemisphereCulling(()=>null);culling.update();culling.destroy();
} finally {for(const[name,descriptor]of previous){if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globalThis[name];}}
await assert.rejects(import("__OUTSIDE_IMPORT__",{with:{type:"json"}}),/escaped isolated workspace/);
const {NullEngine,Scene,Vector3}=await import("@babylonjs/core"),{createCanvasTextureDevicePorts}=await import("@foss-earth/renderer/babylon");
const {makeCircularMarkerAtlas,createPointSpriteManager,disposeSpriteManagers}=await import("@foss-earth/engine/sprites"),{createOrbitCompass}=await import("@foss-earth/engine/compass");
const layers=await import("@foss-earth/engine/layers");assert.equal(typeof layers.createLayerRegistry,"function");
function createCanvas(width,height){const canvas={width,height};const context={canvas,clearRect(){},fillRect(){},fillText(){},save(){},restore(){},translate(){},beginPath(){},arc(){},fill(){},stroke(){},measureText:()=>({width:20}),getImageData:()=>({data:new Uint8ClampedArray(width*height*4),width,height}),font:"",fillStyle:"",strokeStyle:"",lineWidth:1};return Object.assign(canvas,{getContext:()=>context});}
const engine=new NullEngine(),scene=new Scene(engine);let transfers=0,renders=0;
try {
  const device=createCanvasTextureDevicePorts({scene,createCanvas,transfer:(_bytes,_label,submit)=>{transfers++;return submit();}});
  const atlas=makeCircularMarkerAtlas(device,"consumer-points",[{fill:[255,0,0],stroke:[255,255,255]}]);
  const manager=createPointSpriteManager({scene,name:"consumer",capacity:2,minCapacity:4,texture:atlas});assert.equal(manager.capacity,4);
  const compass=createOrbitCompass(scene,{device,requestRender:()=>{renders++;}});assert.equal(transfers,5);
  compass.update(new Vector3(6378137,0,0),100000);compass.update(new Vector3(6378137,0,0),100000);assert.equal(renders,1);
  compass.destroy();compass.destroy();disposeSpriteManagers([manager]);
} finally {scene.dispose();engine.dispose();}
const {JSDOM}=await import("jsdom"),doc=new JSDOM("<!doctype html>").window.document;
const {createPoiSpriteSizeTuner}=await import("@foss-earth/engine/visualization-tuners");let applied=0,saved=0;
const defaults={maxSize:40000,minSize:200,minRefZoom:100,maxRefZoom:1000000},container=doc.createElement("div");doc.body.append(container);
const tuner=createPoiSpriteSizeTuner(container,()=>{applied++;},{document:doc,settings:{get:id=>defaults[id.split(".").at(-1)],inspect:()=>({provenance:"default"}),setMany:()=>{saved++;return{ok:true};}}});
const input=container.querySelector('[data-field="maxSize"]');input.value="41000";input.dispatchEvent(new doc.defaultView.Event("input"));container.querySelector(".poi-sprite-tuner-apply").click();container.querySelector(".poi-sprite-tuner-save-defaults").click();assert.equal(applied,1);assert.equal(saved,1);tuner.destroy();tuner.destroy();assert.equal(container.childElementCount,0);
const {createImageSessionBroker}=await import("@foss-earth/images"),{createImageFileService}=await import("@foss-earth/images/browser"),{createBoundedMapTextureLoader}=await import("@foss-earth/engine/babylon");
const png=new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,2,0,0,0,1,8,6,0,0,0,0,0,0,0]),file={url:"https://fixture.invalid/tile.png",width:2,height:1,mimeType:"image/png"};
const broker=createImageSessionBroker({pools:{sourceGpu:128,encoded:256,decoded:256,uploadOutstanding:256,overlap:128},requests:1,decodes:1});let closed=0,disposed=0;
try {
  const files=createImageFileService({broker,limits:()=>({responseBytes:256,timeoutMs:1000}),priority:()=>0,fetch:async()=>new Response(png,{headers:{"content-type":"image/png"}}),decode:async()=>({width:2,height:1,close:()=>{closed++;}})});
  const load=createBoundedMapTextureLoader({broker,files,maxTextureSide:()=>256,whenReady:async()=>{},uploader:{upload:async request=>{assert.deepEqual(request.textureColor,{useSRGBBuffer:false,gammaSpace:true});return{kind:"2d",width:2,height:1,levels:2,gpuBytes:12,complete:true,texture:{},dispose:()=>{disposed++;}};}}});
  const image=await load(file,{declaredBytes:png.length,priority:1});assert.equal(closed,1);assert.equal(broker.pools.stats().sourceGpu.reserved,12);image.settleReplacement();image.dispose();assert.equal(disposed,1);assert.deepEqual(broker.pools.live(),[]);
} finally {broker.dispose();}
console.log("Installed pure visualization, layer/sprite/compass canvas ports, tuner lifecycle and bounded map composition passed (CPU fixtures only).");
