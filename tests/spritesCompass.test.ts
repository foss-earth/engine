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
      const label=scene.getMeshByName("orbit-compass-label-N")! as Mesh;expect(compass.isMesh(label)).toBe(true);
      compass.update(new Vector3(6378137,0,0),100_000);expect(requestRender).toHaveBeenCalledTimes(1);
      compass.update(new Vector3(6378137,0,0),100_000);expect(requestRender).toHaveBeenCalledTimes(1);
      compass.update(null,100_000);expect(requestRender).toHaveBeenCalledTimes(2);expect(label.isEnabled()).toBe(false);
      compass.destroy();compass.destroy();expect(scene.getMeshByName("orbit-compass-label-N")).toBeNull();atlas.dispose();
    } finally {scene.dispose();engine.dispose();}
  });
  it("draws a compass move within a metre in the frame being drawn, asking for another frame only past a metre",()=>{
    const engine=new NullEngine(),scene=new Scene(engine),requestRender=vi.fn();
    const device=createCanvasTextureDevicePorts({scene,createCanvas:canvasRealm,transfer:(_bytes,_label,submit)=>submit()});
    try {
      const compass=createOrbitCompass(scene,{device,requestRender});
      compass.setScaleParams({radiusScale:0.1,minRadius:100,maxRadius:100_000,labelSizeScale:0.01});
      const label=scene.getMeshByName("orbit-compass-label-N")!;
      // At (R, 0, 0) up is +x and north is +z.
      compass.update(new Vector3(6378137,0,0),100_000);expect(requestRender).toHaveBeenCalledTimes(1);
      const north=label.position.z,up=label.position.x;
      // Half a metre up, and a radius 200 m larger, within its 500 m step: the label rises, its radius stays.
      compass.update(new Vector3(6378137.5,0,0),102_000);expect(requestRender).toHaveBeenCalledTimes(1);
      expect(label.position.x-up).toBeCloseTo(0.5,6);expect(label.position.z).toBe(north);
      // 1.2 m from where it last asked for a frame, though 0.7 m from the last drawn.
      compass.update(new Vector3(6378138.2,0,0),100_000);expect(requestRender).toHaveBeenCalledTimes(2);
      expect(label.position.x-up).toBeCloseTo(1.2,6);
      compass.update(new Vector3(6378138.2,0,0),100_000);expect(requestRender).toHaveBeenCalledTimes(2);
      compass.destroy();
    } finally {scene.dispose();engine.dispose();}
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
    try {
      vi.spyOn(scene, "pickSprite").mockReturnValue({ hit: false } as never);
      const pick = vi.spyOn(scene, "pick").mockImplementation((_x, _y, predicate) => {
        const mesh = [point, ground, tile].find(candidate => predicate?.(candidate as never, 0));
        return { hit: Boolean(mesh), pickedMesh: mesh } as never;
      });
      expect(pickPointMetadata(scene, 10, 20)).toEqual({ id: "authored" });
      expect(hasPickablePointAt(scene, 10, 20)).toBe(true);
      pick.mockImplementation((_x, _y, predicate) => {
        const mesh = [ground, tile].find(candidate => predicate?.(candidate as never, 0));
        return { hit: Boolean(mesh), pickedMesh: mesh } as never;
      });
      expect(pickPointMetadata(scene, 10, 20)).toBeNull();
      expect(hasPickablePointAt(scene, 10, 20)).toBe(false);
    } finally { scene.dispose(); engine.dispose(); }
  });
});
