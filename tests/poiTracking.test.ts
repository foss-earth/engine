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
    tracking.setPois([poi]);tracking.enterTracking(poi);expect(enter).toHaveBeenCalledTimes(1);
    tracking.setSuspended(true);position=new Vector3(4,5,6);scene.onBeforeRenderObservable.notifyObservers(scene as unknown as Scene);expect(camera.center).toEqual(Vector3.Zero());
    tracking.setSuspended(false);for(let frame=0;frame<200;frame+=1)scene.onBeforeRenderObservable.notifyObservers(scene as unknown as Scene);expect(camera.center).toBe(position);
    requestRender.mockClear();
    tracking.destroy();tracking.destroy();tracking.enterTracking(poi);tracking.setPois([poi]);expect(exit).toHaveBeenCalledTimes(1);expect(enter).toHaveBeenCalledTimes(1);expect(tracking.isTracking()).toBe(false);
    scene.onBeforeRenderObservable.notifyObservers(scene as unknown as Scene);click(1,1);expect(scene.pick).not.toHaveBeenCalled();expect(requestRender).toHaveBeenCalledTimes(1);
  });
  it("eases the centre onto a newly tracked point at the same pace whatever the frame rate, never jumping", () => {
    const run = (frameMs: number) => {
      const { scene } = stubScene();
      Object.assign(scene, { getEngine: () => ({ getRenderingCanvas: () => null, getDeltaTime: () => frameMs }) });
      const camera = { center: new Vector3(1000, 0, 0) };
      const requestRender = vi.fn();
      const poi = { mesh: { name: "point" } as AbstractMesh, getPosition: () => new Vector3(0, 0, 0) };
      const tracking = createPoiTracking(scene as unknown as Scene, () => camera as GeospatialCamera, { requestRender, entryKeepPerFrame: () => 0.9 });
      tracking.setPois([poi]);
      tracking.enterTracking(poi);
      // Entering moves nothing by itself.
      expect(camera.center.x).toBe(1000);
      const steps: number[] = [];
      for (let frame = 0; frame < Math.round(250 / frameMs); frame += 1) {
        const before = camera.center.x;
        scene.onBeforeRenderObservable.notifyObservers(scene as unknown as Scene);
        steps.push(before - camera.center.x);
      }
      const afterQuarterSecond = camera.center.x;
      expect(requestRender).toHaveBeenCalled();
      tracking.destroy();
      return { afterQuarterSecond, largestStep: Math.max(...steps) };
    };
    const at60 = run(1000 / 60), at120 = run(1000 / 120);
    expect(at60.afterQuarterSecond).toBeCloseTo(1000 * 0.9 ** 15, 6);
    expect(at120.afterQuarterSecond).toBeCloseTo(at60.afterQuarterSecond, 6);
    // No frame moves the centre by more than the first 60 Hz frame's tenth of the way.
    expect(at60.largestStep).toBeLessThanOrEqual(100 + 1e-9);
    expect(at120.largestStep).toBeLessThan(at60.largestStep);
  });
  it("lets the centre settle on the point and then follows it exactly", () => {
    const { scene } = stubScene();
    let position = new Vector3(10, 0, 0);
    const camera = { center: new Vector3(10.005, 0, 0) };
    const poi = { mesh: { name: "point" } as AbstractMesh, getPosition: () => position };
    const tracking = createPoiTracking(scene as unknown as Scene, () => camera as GeospatialCamera);
    tracking.setPois([poi]);
    tracking.enterTracking(poi);
    scene.onBeforeRenderObservable.notifyObservers(scene as unknown as Scene);
    // Within a centimetre it is already there.
    expect(camera.center).toBe(position);
    position = new Vector3(11, 0, 0);
    scene.onBeforeRenderObservable.notifyObservers(scene as unknown as Scene);
    expect(camera.center).toBe(position);
    tracking.destroy();
  });
});
