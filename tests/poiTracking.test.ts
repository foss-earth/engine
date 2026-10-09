import { Observable, PointerEventTypes, Vector3, type AbstractMesh, type GeospatialCamera, type PointerInfo, type Scene } from "@babylonjs/core";
import { describe, expect, it, vi } from "vitest";
import { createPoiTracking } from "../src/layers/poiTracking.js";

function stubScene() {
  const onPointerObservable = new Observable<PointerInfo>();
  const scene = {
    onPointerObservable,
    onBeforeRenderObservable: new Observable<Scene>(),
    getEngine: () => ({ getRenderingCanvas: () => null }),
    pick: vi.fn(() => ({ hit: false, pickedMesh: null })),
  };
  const press = (type: number, x: number) => onPointerObservable.notifyObservers({
    type, event: { pointerType: "mouse", button: 0, clientX: x, clientY: 0, offsetX: x, offsetY: 0 },
  } as unknown as PointerInfo);
  return { scene, click: (from: number, to: number) => { press(PointerEventTypes.POINTERDOWN, from); press(PointerEventTypes.POINTERUP, to); } };
}

describe("createPoiTracking", () => {
  it("takes a press as a click only while it moves less than input.mouse.dragThreshold", () => {
    const { scene, click } = stubScene();
    let threshold = 4;
    const tracking = createPoiTracking(scene as unknown as Scene, () => null, { dragThresholdPx: () => threshold });

    click(100, 103);
    expect(scene.pick).toHaveBeenCalledTimes(1);
    // The map took this one as a drag.
    click(100, 104);
    expect(scene.pick).toHaveBeenCalledTimes(1);
    threshold = 8;
    click(100, 104);
    expect(scene.pick).toHaveBeenCalledTimes(2);

    tracking.destroy();
  });
  it("retains source tracking/suspension and closes callbacks once before late host calls",()=>{
    const {scene,click}=stubScene(),enter=vi.fn(),exit=vi.fn(),requestRender=vi.fn();let position=new Vector3(1,2,3);
    const camera={center:Vector3.Zero()},poi={mesh:{name:"point"} as AbstractMesh,getPosition:()=>position,onTrackingEnter:enter,onTrackingExit:exit};
    const tracking=createPoiTracking(scene as unknown as Scene,()=>camera as GeospatialCamera,{requestRender});
    tracking.setPois([poi]);tracking.enterTracking(poi);expect(camera.center).toBe(position);expect(enter).toHaveBeenCalledTimes(1);
    tracking.setSuspended(true);position=new Vector3(4,5,6);scene.onBeforeRenderObservable.notifyObservers(scene as unknown as Scene);expect(camera.center).not.toBe(position);
    tracking.setSuspended(false);scene.onBeforeRenderObservable.notifyObservers(scene as unknown as Scene);expect(camera.center).toBe(position);
    tracking.destroy();tracking.destroy();tracking.enterTracking(poi);tracking.setPois([poi]);expect(exit).toHaveBeenCalledTimes(1);expect(enter).toHaveBeenCalledTimes(1);expect(tracking.isTracking()).toBe(false);
    scene.onBeforeRenderObservable.notifyObservers(scene as unknown as Scene);click(1,1);expect(scene.pick).not.toHaveBeenCalled();expect(requestRender).toHaveBeenCalledTimes(2);
  });
});
