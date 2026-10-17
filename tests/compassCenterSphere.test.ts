import { afterEach, describe, expect, it } from "vitest";
import { NullEngine, Scene, ShaderMaterial, UniversalCamera, Vector3, type Mesh } from "@babylonjs/core";
import { COMPASS_CENTER_SPHERE_OPACITY, COMPASS_CENTER_SPHERE_RADIUS_PX, createCompassCenterSphere } from "../src/visualization/compassCenterSphere.js";

const engines: NullEngine[] = [];
afterEach(() => { for (const engine of engines.splice(0)) engine.dispose(); });

function sceneWithCamera() {
  const engine = new NullEngine();
  engines.push(engine);
  const scene = new Scene(engine);
  scene.activeCamera = new UniversalCamera("camera", new Vector3(0, 0, -100), scene);
  const canvas = { clientWidth: 800, clientHeight: 600 } as HTMLCanvasElement;
  return { scene, canvas };
}

const meshOf = (scene: Scene) => scene.getMeshByName("compass-center-sphere") as Mesh;
const uniforms = (mesh: Mesh) => {
  // Babylon keeps a ShaderMaterial's uniform values in private maps; there is no getter.
  const material = mesh.material as unknown as { _floats: Record<string, number>; _vectors2: Record<string, { x: number; y: number }>; _colors4: Record<string, { a: number }> };
  return { floats: material._floats, vectors: material._vectors2, colors: material._colors4 };
};

describe("the compass center's sphere", () => {
  it("is one camera-facing quad with no texture, never picked, culled or writing depth, and hidden until shown", () => {
    const { scene, canvas } = sceneWithCamera();
    createCompassCenterSphere(scene, canvas);
    const mesh = meshOf(scene);
    expect(mesh.getTotalVertices()).toBe(4);
    expect(mesh.getTotalIndices()).toBe(6);
    expect(mesh.isEnabled()).toBe(false);
    expect(mesh.isPickable).toBe(false);
    expect(mesh.alwaysSelectAsActiveMesh).toBe(true);
    const material = mesh.material as ShaderMaterial;
    expect(material).toBeInstanceOf(ShaderMaterial);
    expect(material.getActiveTextures()).toEqual([]);
    expect(material.disableDepthWrite).toBe(true);
    expect(material.needAlphaBlending()).toBe(true);
    expect(scene.textures).toHaveLength(0);
  });

  it("stands at the point, as opaque as the level, and the size on screen it is given", () => {
    const { scene, canvas } = sceneWithCamera();
    const sphere = createCompassCenterSphere(scene, canvas);
    const mesh = meshOf(scene);
    sphere.show(new Vector3(10, 20, 30), 1);
    expect(mesh.isEnabled()).toBe(true);
    expect(mesh.position.asArray()).toEqual([10, 20, 30]);
    const { floats, vectors, colors } = uniforms(mesh);
    expect(colors.color!.a).toBeCloseTo(COMPASS_CENTER_SPHERE_OPACITY, 9);
    expect(vectors.radiusClip!.x).toBeCloseTo(2 * COMPASS_CENTER_SPHERE_RADIUS_PX / 800, 9);
    expect(vectors.radiusClip!.y).toBeCloseTo(2 * COMPASS_CENTER_SPHERE_RADIUS_PX / 600, 9);
    expect(floats.edge).toBeGreaterThan(0);

    sphere.show(new Vector3(11, 20, 30), 0.25);
    expect(mesh.position.x).toBe(11);
    expect(colors.color!.a).toBeCloseTo(COMPASS_CENTER_SPHERE_OPACITY / 4, 9);
  });

  it("is disabled, not drawn, for no point, a level of 0, a canvas with no size or a point that is not finite", () => {
    const { scene, canvas } = sceneWithCamera();
    const sphere = createCompassCenterSphere(scene, canvas);
    const mesh = meshOf(scene);
    for (const [point, level] of [[null, 1], [new Vector3(1, 2, 3), 0], [new Vector3(Number.NaN, 2, 3), 1]] as const) {
      sphere.show(new Vector3(1, 2, 3), 1);
      expect(mesh.isEnabled()).toBe(true);
      sphere.show(point, level);
      expect(mesh.isEnabled()).toBe(false);
    }
    const flat = createCompassCenterSphere(scene, { clientWidth: 0, clientHeight: 0 } as HTMLCanvasElement);
    flat.show(new Vector3(1, 2, 3), 1);
    expect(scene.meshes.filter(entry => entry.name === "compass-center-sphere").every(entry => !entry.isEnabled())).toBe(true);
  });

  it("takes its mesh and material with it when disposed, and ignores calls after", () => {
    const { scene, canvas } = sceneWithCamera();
    const sphere = createCompassCenterSphere(scene, canvas);
    const material = meshOf(scene).material!;
    sphere.dispose();
    expect(meshOf(scene)).toBeNull();
    expect(scene.materials).not.toContain(material);
    expect(() => { sphere.show(new Vector3(1, 2, 3), 1); sphere.dispose(); }).not.toThrow();
    expect(meshOf(scene)).toBeNull();
  });
});
