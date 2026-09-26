import { Observable, PointerEventTypes, type PointerInfo, type Scene } from "@babylonjs/core";
import { describe, expect, it, vi } from "vitest";
import { createPoiTracking } from "./poiTracking";

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
});
