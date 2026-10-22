import { describe, expect, it, vi } from "vitest";
import { NullEngine, Scene, Vector3, type Mesh } from "@babylonjs/core";
import { createCanvasTextureDevicePorts } from "@foss-earth/renderer/babylon";
import { makeCircularMarkerAtlas, createPointSpriteManager, createPointSprite, disposeSpriteManagers, hasPickablePointAt, pickPointMetadata } from "../src/sprites/index.js";
import { createOrbitCompass } from "../src/visualization/orbitCompass.js";
import { canvasRealm } from "../fixtures/composition/canvasRealm.js";

describe("supplied canvas and scene visualization",()=>{
  it("uses renderer-owned canvas uploads, redraws only changes and destroys owned compass resources",()=>{
    const engine=new NullEngine(),scene=new Scene(engine),transfer=vi.fn(),requestRender=vi.fn();
    const device=createCanvasTextureDevicePorts({scene,createCanvas:canvasRealm,transfer:(bytes,label,submit)=>{transfer(bytes,label);return submit();}});
    try {
      const atlas=makeCircularMarkerAtlas(device,"points",[{fill:[255,0,0],stroke:[255,255,255]},{fill:[0,0,255],stroke:[255,255,255]}]);
      expect(atlas.getSize()).toEqual({width:128,height:64});expect(transfer).toHaveBeenCalledTimes(1);
      const compass=createOrbitCompass(scene,{device,requestRender});expect(transfer).toHaveBeenCalledTimes(5);
      compass.setMode("legacy");
      const label=scene.getMeshByName("orbit-compass-label-N")! as Mesh;expect(compass.isMesh(label)).toBe(true);
      compass.update(new Vector3(6378137,0,0),100_000);expect(requestRender).toHaveBeenCalledTimes(1);
      compass.update(new Vector3(6378137,0,0),100_000);expect(requestRender).toHaveBeenCalledTimes(1);
      expect(scene.getMeshByName("orbit-compass-east-west-axis")!.isEnabled()).toBe(false);
      compass.update(new Vector3(6378137,0,0),400_000);
      const grown = label.scaling.x;
      compass.update(new Vector3(6378137,0,0),800_000);
      expect(label.scaling.x).toBeGreaterThan(grown * 1.5);
      compass.update(null,100_000);expect(requestRender.mock.calls.length).toBeGreaterThan(1);expect(label.isEnabled()).toBe(false);
      compass.setMode("horizon");
      const eye = new Vector3(6_378_137 + 2_000_000, 0, 0);
      compass.update(new Vector3(6378137,0,0), 2_000_000, eye);
      expect(label.isEnabled()).toBe(true);
      expect(label.position.z).toBeGreaterThan(1_000);
      expect(scene.getMeshByName("orbit-compass-east-west-axis")!.isEnabled()).toBe(false);
      const horizonRenders = requestRender.mock.calls.length;
      compass.update(new Vector3(6378137,0,0), 2_000_000, eye);
      expect(requestRender).toHaveBeenCalledTimes(horizonRenders);
      compass.destroy();compass.destroy();expect(scene.getMeshByName("orbit-compass-label-N")).toBeNull();atlas.dispose();
    } finally {scene.dispose();engine.dispose();}
  });
  it("draws a compass move within a metre in the frame being drawn, asking for another frame only past a metre",()=>{
    const engine=new NullEngine(),scene=new Scene(engine),requestRender=vi.fn();
    const device=createCanvasTextureDevicePorts({scene,createCanvas:canvasRealm,transfer:(_bytes,_label,submit)=>submit()});
    try {
      const compass=createOrbitCompass(scene,{device,requestRender});
      compass.setMode("legacy");
      compass.setScaleParams({radiusScale:0.1,minRadius:100,maxRadius:100_000,labelSizeScale:0.01});
      const label=scene.getMeshByName("orbit-compass-label-N")!;
      // At (R, 0, 0) up is +x and north is +z.
      compass.update(new Vector3(6378137,0,0),100_000);expect(requestRender).toHaveBeenCalledTimes(1);
      const north=label.position.z,up=label.position.x;
      // Half a metre up, and a radius 200 m larger, within its 500 m step: the label rises, its radius stays.
      // The label's size changes with that zoom, so this frame is asked for. Its radius stays inside the 500 m step.
      compass.update(new Vector3(6378137.5,0,0),102_000);expect(requestRender).toHaveBeenCalledTimes(2);
      expect(label.position.x-up).toBeCloseTo(0.5,6);expect(label.position.z).toBe(north);
      // 1.2 m from where it last asked for a frame, though 0.7 m from the last drawn.
      compass.update(new Vector3(6378138.2,0,0),100_000);expect(requestRender).toHaveBeenCalledTimes(3);
      expect(label.position.x-up).toBeCloseTo(1.2,6);
      compass.update(new Vector3(6378138.2,0,0),100_000);expect(requestRender).toHaveBeenCalledTimes(3);
      compass.destroy();
    } finally {scene.dispose();engine.dispose();}
  });
  it("keeps horizon letters in a host's moving scene frame even when the ECEF eye stays still", () => {
    const engine = new NullEngine(), scene = new Scene(engine), requestRender = vi.fn();
    const device = createCanvasTextureDevicePorts({ scene, createCanvas: canvasRealm, transfer: (_bytes, _label, submit) => submit() });
    const eye = { x: 6_380_137, y: 0, z: 0 };
    let shift = 0;
    const compass = createOrbitCompass(scene, { device, requestRender, ecefToScene: point => ({ x: point.y + shift, y: point.x - eye.x, z: -point.z }) });
    try {
      compass.update(null, 0, eye);
      const north = scene.getMeshByName("orbit-compass-label-N")!;
      expect(north.position.x).toBe(0);
      expect(north.position.z).toBeLessThan(-1_000);
      expect(north.parent).toBeNull(); // Billboard orientation stays in scene space.
      expect(north.isPickable).toBe(false);
      shift = 100;
      compass.update(null, 0, eye);
      expect(north.position.x).toBe(100);
      expect(requestRender).toHaveBeenCalledTimes(2);
      compass.update(null, 0, eye);
      expect(requestRender).toHaveBeenCalledTimes(2);
    } finally { compass.destroy(); scene.dispose(); engine.dispose(); }
  });
  it("retains sprite manager/source metadata semantics while allowing a host-selected capacity floor",()=>{
    const engine=new NullEngine(),scene=new Scene(engine),device=createCanvasTextureDevicePorts({scene,createCanvas:canvasRealm,transfer:(_bytes,_label,submit)=>submit()});
    try {
      const texture=makeCircularMarkerAtlas(device,"point",[{fill:[255,0,0],stroke:[255,255,255]}]);
      const manager=createPointSpriteManager({scene,name:"points",capacity:2,minCapacity:4,texture});expect(manager.capacity).toBe(4);
      const sprite=createPointSprite({manager,name:"point",position:new Vector3(1,2,3),size:20,metadata:{id:"authored"},opacity:.5});expect(sprite.position.asArray()).toEqual([1,2,3]);expect(sprite.color.a).toBe(.5);
      vi.spyOn(scene,"pickSprite").mockReturnValue({hit:true,pickedSprite:sprite} as never);expect(pickPointMetadata(scene,0,0)).toEqual({id:"authored"});
      disposeSpriteManagers([manager]);expect(manager.sprites).toHaveLength(0);
    } finally {scene.dispose();engine.dispose();}
  });
  it("treats a point of interest as pickable and the ground's own metadata as the ground", () => {
    const engine = new NullEngine(), scene = new Scene(engine);
    const ground = { metadata: { mapSurface: true, terrainZoom: 6, segments: 32, heightBounds: { min: 0, max: 1 } } };
    const tile = { metadata: { googleGeometricErrorMeters: 12 } };
    const point = { metadata: { id: "authored" } };
    // A prepared tile keeps its admission provenance and is still the ground.
    const prepared = { metadata: { ...ground.metadata, preparationAdmission: { backend: "wasm-single", validationStatus: "validated", evidence: "parity" } } };
    try {
      vi.spyOn(scene, "pickSprite").mockReturnValue({ hit: false } as never);
      const pick = vi.spyOn(scene, "pick").mockImplementation((_x, _y, predicate) => {
        const mesh = [point, ground, tile].find(candidate => predicate?.(candidate as never, 0));
        return { hit: Boolean(mesh), pickedMesh: mesh } as never;
      });
      expect(pickPointMetadata(scene, 10, 20)).toEqual({ id: "authored" });
      expect(hasPickablePointAt(scene, 10, 20)).toBe(true);
      pick.mockImplementation((_x, _y, predicate) => {
        const mesh = [ground, tile, prepared].find(candidate => predicate?.(candidate as never, 0));
        return { hit: Boolean(mesh), pickedMesh: mesh } as never;
      });
      expect(pickPointMetadata(scene, 10, 20)).toBeNull();
      expect(hasPickablePointAt(scene, 10, 20)).toBe(false);
    } finally { scene.dispose(); engine.dispose(); }
  });
});
