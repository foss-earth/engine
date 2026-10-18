/** Worker-built immutable spatial index. Header [node count, face count], then
 * ten f64 values per node [low xyz, high xyz, left, right, start, count], then
 * original face IDs. Positions/indices remain the displayed Float32 geometry. */
export type GroundBvhSnapshot = Float64Array;
export interface GroundLocalRay { origin: { x: number; y: number; z: number }; direction: { x: number; y: number; z: number }; length: number; epsilon: number }
export interface GroundLocalHit { distance: number; face: number; bu: number; bv: number }
export const GROUND_MAX_TRIANGLES = 262_144;

export function buildGroundBvh(positions: Float32Array, indices: Uint32Array): GroundBvhSnapshot {
  if (!positions.length || positions.length % 3 || positions.length / 3 > 1_048_576 || !indices.length || indices.length % 3
    || indices.length / 3 > GROUND_MAX_TRIANGLES || positions.some(value => !Number.isFinite(value))
    || indices.some(value => value >= positions.length / 3)) throw new RangeError("Invalid ground geometry.");
  const faces = Array.from({ length: indices.length / 3 }, (_, face) => face), nodes: number[] = [];
  const center = (face: number, axis: number) => (positions[indices[face * 3] * 3 + axis]
    + positions[indices[face * 3 + 1] * 3 + axis] + positions[indices[face * 3 + 2] * 3 + axis]) / 3;
  const split = (start: number, count: number): number => {
    const low = [Infinity, Infinity, Infinity], high = [-Infinity, -Infinity, -Infinity];
    for (let at = start; at < start + count; at++) for (let corner = 0; corner < 3; corner++) for (let axis = 0; axis < 3; axis++) {
      const value = positions[indices[faces[at] * 3 + corner] * 3 + axis];
      low[axis] = Math.min(low[axis], value); high[axis] = Math.max(high[axis], value);
    }
    const node = nodes.length / 10;
    nodes.push(...low, ...high, 0, 0, start, count);
    if (count > 8) {
      let axis = 0;
      if (high[1] - low[1] > high[0] - low[0]) axis = 1;
      if (high[2] - low[2] > high[axis] - low[axis]) axis = 2;
      const ordered = faces.slice(start, start + count).sort((a, b) => center(a, axis) - center(b, axis) || a - b);
      for (let offset = 0; offset < count; offset++) faces[start + offset] = ordered[offset];
      const mid = Math.floor(count / 2);
      const left = split(start, mid), right = split(start + mid, count - mid);
      nodes[node * 10 + 6] = left; nodes[node * 10 + 7] = right; nodes[node * 10 + 9] = 0;
    }
    return node;
  };
  split(0, faces.length);
  const result = new Float64Array(2 + nodes.length + faces.length);
  result[0] = nodes.length / 10; result[1] = faces.length; result.set(nodes, 2); result.set(faces, 2 + nodes.length);
  return result;
}

/** Validate bounds, topology and a one-to-one original-face permutation before publication. */
export function validateGroundBvh(snapshot: GroundBvhSnapshot, faceCount: number): void {
  const nodes = snapshot[0], faces = snapshot[1];
  if (!Number.isSafeInteger(nodes) || nodes < 1 || nodes > 2 * faceCount || faces !== faceCount
    || snapshot.length !== 2 + nodes * 10 + faces || faceCount > GROUND_MAX_TRIANGLES) throw new RangeError("Invalid ground BVH header.");
  const seenNodes = new Uint8Array(nodes), seenFaces = new Uint8Array(faces), stack = [0];
  const faceOffset = 2 + nodes * 10;
  while (stack.length) {
    const index = stack.pop()!;
    if (!Number.isSafeInteger(index) || index < 0 || index >= nodes || seenNodes[index]) throw new RangeError("Invalid ground BVH topology.");
    seenNodes[index] = 1;
    const at = 2 + index * 10;
    for (let axis = 0; axis < 3; axis++) if (!Number.isFinite(snapshot[at + axis]) || !Number.isFinite(snapshot[at + axis + 3])
      || snapshot[at + axis] > snapshot[at + axis + 3]) throw new RangeError("Invalid ground BVH bounds.");
    const start = snapshot[at + 8], count = snapshot[at + 9];
    if (!Number.isSafeInteger(count) || count < 0) throw new RangeError("Invalid ground BVH leaf.");
    if (count === 0) { stack.push(snapshot[at + 6], snapshot[at + 7]); continue; }
    if (!Number.isSafeInteger(start) || start < 0 || start + count > faces) throw new RangeError("Invalid ground BVH leaf range.");
    for (let slot = start; slot < start + count; slot++) {
      const face = snapshot[faceOffset + slot];
      if (!Number.isSafeInteger(face) || face < 0 || face >= faces || seenFaces[face]) throw new RangeError("Invalid ground BVH face order.");
      seenFaces[face] = 1;
    }
  }
  if (seenNodes.some(value => value !== 1) || seenFaces.some(value => value !== 1)) throw new RangeError("Incomplete ground BVH.");
}

/** Babylon triangle arithmetic and original-face ties, with conservative finite segment pruning. */
export function queryGroundBvh(snapshot: GroundBvhSnapshot, positions: Float32Array, indices: Uint32Array, ray: GroundLocalRay): GroundLocalHit | null {
  const origin = [ray.origin.x, ray.origin.y, ray.origin.z], direction = [ray.direction.x, ray.direction.y, ray.direction.z];
  const stack = [0], faceOffset = 2 + snapshot[0] * 10;
  let best = ray.length, hit: GroundLocalHit | null = null;
  while (stack.length) {
    const at = 2 + stack.pop()! * 10;
    let near = 0, far = best, intersects = true;
    for (let axis = 0; axis < 3; axis++) {
      const padding = 0.001 + 2 * ray.epsilon * (snapshot[at + 3 + axis] - snapshot[at + axis]);
      const low = snapshot[at + axis] - padding, high = snapshot[at + 3 + axis] + padding;
      if (direction[axis] === 0) { if (origin[axis] < low || origin[axis] > high) { intersects = false; break; } continue; }
      const a = (low - origin[axis]) / direction[axis], b = (high - origin[axis]) / direction[axis];
      near = Math.max(near, Math.min(a, b)); far = Math.min(far, Math.max(a, b));
      if (near > far) { intersects = false; break; }
    }
    if (!intersects) continue;
    const start = snapshot[at + 8], count = snapshot[at + 9];
    if (count === 0) { stack.push(snapshot[at + 6], snapshot[at + 7]); continue; }
    for (let slot = start; slot < start + count; slot++) {
      const face = snapshot[faceOffset + slot], a = indices[face * 3] * 3, b = indices[face * 3 + 1] * 3, c = indices[face * 3 + 2] * 3;
      const ex = positions[b] - positions[a], ey = positions[b + 1] - positions[a + 1], ez = positions[b + 2] - positions[a + 2];
      const fx = positions[c] - positions[a], fy = positions[c + 1] - positions[a + 1], fz = positions[c + 2] - positions[a + 2];
      const px = direction[1] * fz - direction[2] * fy, py = direction[2] * fx - direction[0] * fz, pz = direction[0] * fy - direction[1] * fx;
      const det = ex * px + ey * py + ez * pz;
      if (det === 0) continue;
      const invdet = 1 / det, tx = origin[0] - positions[a], ty = origin[1] - positions[a + 1], tz = origin[2] - positions[a + 2];
      const bv = (tx * px + ty * py + tz * pz) * invdet;
      if (bv < -ray.epsilon || bv > 1 + ray.epsilon) continue;
      const qx = ty * ez - tz * ey, qy = tz * ex - tx * ez, qz = tx * ey - ty * ex;
      const bw = (direction[0] * qx + direction[1] * qy + direction[2] * qz) * invdet;
      if (bw < -ray.epsilon || bv + bw > 1 + ray.epsilon) continue;
      const distance = (fx * qx + fy * qy + fz * qz) * invdet;
      if (!Number.isFinite(distance) || distance > ray.length || distance < 0) continue;
      if (distance < best || (distance === best && (!hit || face < hit.face))) { best = distance; hit = { distance, face, bu: 1 - bv - bw, bv }; }
    }
  }
  return hit;
}
