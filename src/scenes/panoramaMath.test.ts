import { describe, expect, it } from "vitest";
import {
  angleDeg,
  blendedWindowTheta,
  captureRelativeMarker,
  contentMatrix,
  CUBE_FACE_NAMES,
  DEG_TO_RAD,
  dot,
  enuDirection,
  enuFrame,
  enuHeadingPitch,
  equirectCoordinates,
  equirectDirection,
  expansionTargetRadius,
  flatWindowDirection,
  flatWindowTheta,
  geodeticPoint,
  gpuCubeLookup,
  gpuSampleVector,
  GPU_LAYER_SOURCE_FACES,
  groundQueryPoint,
  handoffReady,
  imagePoseMatrix,
  length,
  mulMat3,
  normalize,
  orbGeometry,
  pointGeodetic,
  previewFaceTexels,
  projectedDiameterPx,
  radiusForDiameterPx,
  scale,
  sourceCubeDirection,
  sourceCubeLookup,
  sub,
  viewportCovered,
  viewRay,
  type Vec3,
  type ViewBasis,
} from "./panoramaMath";

const BETA_R = 45 * DEG_TO_RAD;

function lookingAt(from: Vec3, target: Vec3, verticalFovDeg: number, aspect: number): ViewBasis {
  const forward = normalize(sub(target, from));
  const right = normalize([forward[1], -forward[0], 0]);
  const up = [right[1] * forward[2] - right[2] * forward[1], right[2] * forward[0] - right[0] * forward[2], right[0] * forward[1] - right[1] * forward[0]] as Vec3;
  return { forward, right, up, verticalFovRad: verticalFovDeg * DEG_TO_RAD, aspect };
}

describe("the flat window", () => {
  it("reproduces the required counterexample: covered, but a 30° ray samples 32.842°", () => {
    // Square 60° viewport, 90° preview, d/R = 1.5.
    const camera: Vec3 = [0, -1.5, 0];
    const view = lookingAt(camera, [0, 0, 0], 60, 1);
    const geometry = orbGeometry(sub([0, 0, 0], camera), 1);
    expect(geometry.alpha / DEG_TO_RAD).toBeCloseTo(41.810315, 5);
    expect(viewportCovered(geometry, view)).toBe(true);
    expect(handoffReady(geometry, view, BETA_R)).toBe(false);
    const ray = enuDirection(30, 0);
    const mapped = flatWindowDirection(geometry, ray, BETA_R)!;
    expect(angleDeg(mapped, [0, 1, 0])).toBeCloseTo(32.842130, 5);
  });

  it("agrees with the reference's angular form everywhere on the disc", () => {
    for (const distance of [8, 3, 1.58, 1.5, 1.42]) {
      const geometry = orbGeometry([0, distance, 0], 1);
      for (let i = 0; i <= 64; i++) {
        const delta = geometry.alpha * i / 64;
        const ray = enuDirection(delta / DEG_TO_RAD, 0);
        const mapped = flatWindowDirection(geometry, ray, BETA_R)!;
        const expected = flatWindowTheta(delta, geometry.alpha, BETA_R);
        expect(angleDeg(mapped, [0, 1, 0])).toBeCloseTo(expected / DEG_TO_RAD, 9);
      }
    }
  });

  it("is identity once α ≥ βR, and at and inside the surface", () => {
    const view = lookingAt([0, -1.3, 0], [0.2, 0, 0.1], 60, 16 / 9);
    for (const distance of [1 / Math.sin(BETA_R), 1.3, 1.000001, 1, 0.5, 0]) {
      const geometry = orbGeometry([0, distance, 0], 1);
      for (const [x, y] of [[0.5, 0.5], [0.2, 0.7], [0.9, 0.1]]) {
        const ray = viewRay(view, x, y);
        const mapped = flatWindowDirection(geometry, ray, BETA_R);
        if (mapped) expect(angleDeg(mapped, ray)).toBeLessThan(1e-9);
      }
    }
    // The outward ray at the surface is uncovered; just inside it is covered.
    expect(flatWindowDirection(orbGeometry([0, 1, 0], 1), [0, -1, 0], BETA_R)).toBeNull();
    expect(flatWindowDirection(orbGeometry([0, 0.999999, 0], 1), [0, -1, 0], BETA_R)).not.toBeNull();
  });

  it("stays finite and continuous across α = βR", () => {
    const threshold = 1 / Math.sin(BETA_R);
    for (const epsilon of [1e-3, 1e-6]) {
      const near = orbGeometry([0, threshold + epsilon, 0], 1);
      const far = orbGeometry([0, threshold - epsilon, 0], 1);
      for (const deg of [0, 10, 20, 30, 40]) {
        const ray = enuDirection(deg, 5);
        const a = flatWindowDirection(near, ray, BETA_R);
        const b = flatWindowDirection(far, ray, BETA_R);
        if (!a || !b) continue;
        expect(a.every(Number.isFinite)).toBe(true);
        expect(angleDeg(a, b)).toBeLessThan(epsilon * 100);
      }
    }
  });

  it("rejects half angles outside (0, 90)", () => {
    const geometry = orbGeometry([0, 3, 0], 1);
    for (const bad of [0, Math.PI / 2, Math.PI]) expect(() => flatWindowDirection(geometry, [0, 1, 0], bad)).toThrow(RangeError);
  });

  it("blends monotonically and finitely from fisheye to flat", () => {
    const options = { previewHalfAngleRad: BETA_R, fisheyeHalfAngleRad: Math.PI / 2, blendStartRad: 20 * DEG_TO_RAD, blendEndRad: BETA_R };
    for (const alphaDeg of [1e-6, 10, 20, 30, 44.999999, 45, 60, 89.999999]) {
      let previous = -1;
      for (let i = 0; i <= 256; i++) {
        const delta = alphaDeg * DEG_TO_RAD * i / 256;
        const theta = blendedWindowTheta(delta, alphaDeg * DEG_TO_RAD, options);
        expect(Number.isFinite(theta)).toBe(true);
        expect(theta).toBeGreaterThanOrEqual(previous);
        previous = theta;
      }
    }
    expect(() => blendedWindowTheta(0.1, 0.2, { ...options, blendStartRad: 46 * DEG_TO_RAD })).toThrow(RangeError);
  });
});

describe("expansion to a handoff", () => {
  it("reaches coverage and ray equality at the target radius, and never beyond 90°", () => {
    const camera: Vec3 = [0, 0, 0];
    const marker: Vec3 = [3, 40, 2];
    const view = lookingAt(camera, [0, 1, 0], 60, 16 / 9);
    const axis = normalize(marker);
    const radius = expansionTargetRadius(length(marker), axis, view, BETA_R)!;
    expect(radius).toBeLessThan(length(marker));
    const geometry = orbGeometry(marker, radius);
    expect(handoffReady(geometry, view, BETA_R)).toBe(true);
    const smaller = orbGeometry(marker, radius * 0.99);
    expect(handoffReady(smaller, view, BETA_R)).toBe(false);
    // An orb behind the viewer's shoulder cannot cover the view by growing.
    expect(expansionTargetRadius(40, normalize([40, -5, 0]), view, BETA_R)).toBeNull();
  });
});

describe("image pose and frames", () => {
  it("heading turns image forward clockwise from north; pitch raises it", () => {
    expect(mulMat3(imagePoseMatrix({ headingDeg: 90, pitchDeg: 0, rollDeg: 0 }), [0, 1, 0]).map(x => +x.toFixed(12))).toEqual([1, 0, 0]);
    const up = mulMat3(imagePoseMatrix({ headingDeg: 0, pitchDeg: 30, rollDeg: 0 }), [0, 1, 0]);
    expect(angleDeg(up, enuDirection(0, 30))).toBeLessThan(1e-9);
  });

  it("maps a world direction back to the image through the inverse pose", () => {
    const frame = enuFrame(-93.235, 44.974);
    const pose = { headingDeg: 37, pitchDeg: -4, rollDeg: 12 };
    const content = contentMatrix(frame, pose);
    const imageForward: Vec3 = [0, 1, 0];
    const enu = mulMat3(imagePoseMatrix(pose), imageForward);
    const world = [0, 1, 2].map(i => frame.east[i] * enu[0] + frame.north[i] * enu[1] + frame.up[i] * enu[2]) as unknown as Vec3;
    expect(angleDeg(mulMat3(content, world), imageForward)).toBeLessThan(1e-9);
  });

  it("zero pose: a camera south of the marker looking north sees the image's north", () => {
    const frame = enuFrame(-93.235, 44.974);
    const content = contentMatrix(frame, { headingDeg: 0, pitchDeg: 0, rollDeg: 0 });
    expect(angleDeg(mulMat3(content, frame.north), [0, 1, 0])).toBeLessThan(1e-9);
    expect(angleDeg(mulMat3(content, frame.east), [1, 0, 0])).toBeLessThan(1e-9);
  });

  it("keeps the last heading at a vertical look", () => {
    expect(enuHeadingPitch([0, 0, 1], 123)).toEqual({ headingDeg: 123, pitchDeg: 90 });
    expect(enuHeadingPitch(enuDirection(250, -10)).headingDeg).toBeCloseTo(250, 9);
  });
});

describe("source conventions", () => {
  it("equirectangular coordinates round-trip with the centre forward", () => {
    expect(angleDeg(equirectDirection(0.5, 0.5), [0, 1, 0])).toBeLessThan(1e-12);
    expect(angleDeg(equirectDirection(0.75, 0.5), [1, 0, 0])).toBeLessThan(1e-12);
    for (const [u, v] of [[0.1, 0.2], [0.6, 0.9], [0.99, 0.45]]) {
      const back = equirectCoordinates(equirectDirection(u, v));
      expect(back.u).toBeCloseTo(u, 12);
      expect(back.v).toBeCloseTo(v, 12);
    }
  });

  it("each source face's table direction lands back on the same face and texel", () => {
    for (const face of CUBE_FACE_NAMES) {
      for (const [u, v] of [[0.5, 0.5], [0.1, 0.8], [0.95, 0.05]]) {
        const found = sourceCubeLookup(sourceCubeDirection(face, u, v));
        expect(found.face).toBe(face);
        expect(found.u).toBeCloseTo(u, 12);
        expect(found.v).toBeCloseTo(v, 12);
      }
    }
  });

  it("uploading each face unrotated into its layer and sampling (x, z, y) reads the same texel", () => {
    const n = 16;
    for (const face of CUBE_FACE_NAMES) {
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        const u = (i + 0.5) / n, v = (j + 0.5) / n;
        const gpu = gpuCubeLookup(gpuSampleVector(sourceCubeDirection(face, u, v)));
        expect(GPU_LAYER_SOURCE_FACES[gpu.layer]).toBe(face);
        expect(gpu.u).toBeCloseTo(u, 12);
        expect(gpu.v).toBeCloseTo(v, 12);
      }
    }
  });
});

describe("placement and sizes", () => {
  it("offsets a ground-relative query point east and north on the ellipsoid", () => {
    const capture = { longitudeDeg: -93.235, latitudeDeg: 44.974 };
    const point = groundQueryPoint(capture, 100, 50);
    const frame = enuFrame(capture.longitudeDeg, capture.latitudeDeg);
    const delta = sub(geodeticPoint(point.longitudeDeg, point.latitudeDeg, 0), geodeticPoint(capture.longitudeDeg, capture.latitudeDeg, 0));
    expect(dot(delta, frame.east)).toBeCloseTo(100, 1);
    expect(dot(delta, frame.north)).toBeCloseTo(50, 1);
    expect(groundQueryPoint(capture, 0, 0).latitudeDeg).toBeCloseTo(44.974, 12);
  });

  it("raises a capture-relative marker along the local vertical", () => {
    const capture = { longitudeDeg: 10, latitudeDeg: 50 };
    const marker = captureRelativeMarker(capture, 200, 0, 0, 30);
    expect(pointGeodetic(marker).heightMeters).toBeCloseTo(230, 6);
  });

  it("projected diameter and radius-for-diameter are inverses", () => {
    const fov = 60 * DEG_TO_RAD;
    const diameter = projectedDiameterPx(2, 100, fov, 900);
    expect(radiusForDiameterPx(diameter, 100, fov, 900)).toBeCloseTo(2, 12);
    expect(previewFaceTexels(96, BETA_R, 1)).toBeCloseTo(96, 9);
    expect(length(scale([3, 4, 0], 2))).toBe(10);
  });
});
