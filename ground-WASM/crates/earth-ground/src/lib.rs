//! Owned, immutable local-space triangle BVHs for ground queries.
//!
//! The triangle arithmetic follows Babylon's Ray.intersectsTriangle, including
//! epsilon barycentrics, finite ray length and first-face ties. An index is
//! built here or imported from a snapshot, which is validated and adopted as
//! it is, in linear time. World batches also follow the rest of Babylon's pick
//! of one mesh: the ray's transform to mesh space, the bounding sphere and box
//! tests, the picked point and distance, and `PickingInfo.getNormal(true,
//! false)`. Scene eligibility, mesh order and ECEF conversion stay with the
//! host. No ordinary Rust memory is shared with a concurrent reader. A mesh
//! handle keeps its geometry alive until its owner releases it.

use std::cell::RefCell;
use std::cmp::Ordering;
use std::mem::size_of;

const MAX_BYTES: usize = 128 * 1024 * 1024;
const MAX_BUFFERS: usize = 64;
const MAX_MESHES: usize = 64;
const MAX_VERTICES: usize = 1_048_576;
const MAX_TRIANGLES: usize = 262_144;
const MAX_RAYS: usize = 65_536;
const LEAF_SIZE: usize = 8;
/// Deepest leaf an imported index may have; traversal stacks hold
/// `MAX_DEPTH + 1` entries at most. Median splits stay under 20 levels.
const MAX_DEPTH: usize = 48;
const STACK: usize = 64;
const RAY: usize = 8;
const WORLD_ROW: usize = 11;
const INVALID: u32 = 1;
const ALLOCATION: u32 = 2;
const GEOMETRY: u32 = 3;
const MESH: u32 = 4;
const RAYS: u32 = 5;
const SNAPSHOT: u32 = 6;
const TRANSFORM: u32 = 7;

#[derive(Clone, Copy, Default)]
struct V3 {
    x: f64,
    y: f64,
    z: f64,
}
impl V3 {
    fn sub(self, b: Self) -> Self {
        Self {
            x: self.x - b.x,
            y: self.y - b.y,
            z: self.z - b.z,
        }
    }
    fn cross(self, b: Self) -> Self {
        Self {
            x: self.y * b.z - self.z * b.y,
            y: self.z * b.x - self.x * b.z,
            z: self.x * b.y - self.y * b.x,
        }
    }
    fn dot(self, b: Self) -> f64 {
        self.x * b.x + self.y * b.y + self.z * b.z
    }
    fn scale(self, s: f64) -> Self {
        Self {
            x: self.x * s,
            y: self.y * s,
            z: self.z * s,
        }
    }
    /// `Vector3.length()`.
    fn length(self) -> f64 {
        (self.x * self.x + self.y * self.y + self.z * self.z).sqrt()
    }
    /// `normalizeFromLength(length())`: unchanged at length 0 or 1, else
    /// multiplied by the reciprocal.
    fn normalized(self) -> Self {
        let len = self.length();
        if len == 0.0 || len == 1.0 { self } else { self.scale(1.0 / len) }
    }
    fn axis(self, axis: usize) -> f64 {
        match axis {
            0 => self.x,
            1 => self.y,
            _ => self.z,
        }
    }
}
/// Build-time entry. Float32 positions make float32 face bounds exact, and
/// the keys order float64 centroids as the reference's subtraction does.
#[derive(Clone, Copy)]
#[repr(C)]
struct Item {
    key: [i64; 3],
    low: [f32; 3],
    high: [f32; 3],
    face: u32,
}
struct Node {
    low: V3,
    high: V3,
    left: usize,
    right: usize,
    start: usize,
    count: usize,
}
/// A face as `Ray.intersectsTriangle` reads it: its first corner and the two
/// edges from it, subtracted once instead of on every ray.
#[derive(Clone, Copy)]
struct Triangle {
    origin: V3,
    edge1: V3,
    edge2: V3,
}
impl Triangle {
    fn new(a: V3, b: V3, c: V3) -> Self {
        Self {
            origin: a,
            edge1: b.sub(a),
            edge2: c.sub(a),
        }
    }
}
/// A mesh's `BoundingInfo` in mesh space: box, then sphere.
#[derive(Clone, Copy)]
struct Bounds {
    minimum: V3,
    maximum: V3,
    center: V3,
    radius: f64,
}
impl Bounds {
    /// `new BoundingInfo(minimum, maximum)`'s sphere.
    fn of_box(minimum: V3, maximum: V3) -> Self {
        let d = minimum.sub(maximum);
        Self {
            minimum,
            maximum,
            center: V3 {
                x: maximum.x + minimum.x,
                y: maximum.y + minimum.y,
                z: maximum.z + minimum.z,
            }
            .scale(0.5),
            radius: (d.x * d.x + d.y * d.y + d.z * d.z).sqrt() * 0.5,
        }
    }
    /// `Ray.intersectsSphere(boundingSphere)`; the ray is infinite.
    fn sphere(&self, origin: V3, direction: V3) -> bool {
        let x = self.center.x - origin.x;
        let y = self.center.y - origin.y;
        let z = self.center.z - origin.z;
        let pyth = x * x + y * y + z * z;
        let radius = self.radius + 0.0;
        let rr = radius * radius;
        if pyth <= rr {
            return true;
        }
        let dot = x * direction.x + y * direction.y + z * direction.z;
        if dot < 0.0 {
            return false;
        }
        pyth - dot * dot <= rr
    }
    /// `Ray.intersectsBoxMinMax(minimum, maximum)`; the ray is infinite and
    /// a direction under 1e-7 counts as parallel.
    fn boxed(&self, origin: V3, direction: V3) -> bool {
        let mut d = 0.0;
        let mut max_value = f64::MAX;
        for axis in 0..3 {
            let low = self.minimum.axis(axis) - 0.0;
            let high = self.maximum.axis(axis) + 0.0;
            let o = origin.axis(axis);
            let dir = direction.axis(axis);
            if dir.abs() < 0.0000001 {
                if o < low || o > high {
                    return false;
                }
                continue;
            }
            let inv = 1.0 / dir;
            let mut min = (low - o) * inv;
            let mut max = (high - o) * inv;
            if max == f64::NEG_INFINITY {
                max = f64::INFINITY;
            }
            if min > max {
                std::mem::swap(&mut min, &mut max);
            }
            d = js_max(min, d);
            max_value = js_min(max, max_value);
            if d > max_value {
                return false;
            }
        }
        true
    }
}
/// `Math.max` and `Math.min`: NaN wins, and -0 orders below +0.
fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a > b || (a == b && a.is_sign_positive()) {
        a
    } else {
        b
    }
}
fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a < b || (a == b && a.is_sign_negative()) {
        a
    } else {
        b
    }
}
struct Bvh {
    /// Triangles, original face IDs and the face normals `PickingInfo.getNormal`
    /// computes, `(v1 - v2) × (v3 - v2)`, in leaf order.
    triangles: Vec<Triangle>,
    normals: Vec<V3>,
    faces: Vec<u32>,
    nodes: Vec<Node>,
    /// The root box unless the host sets the mesh's own.
    bounds: Bounds,
    bytes: usize,
}
/// Retained bytes per face.
const FACE_BYTES: usize = size_of::<Triangle>() + size_of::<V3>() + size_of::<u32>();
struct Hit {
    distance: f64,
    slot: usize,
    face: u32,
    bu: f64,
    bv: f64,
}
/// Babylon's 4×4 matrices, row-vector convention, as `Matrix.m`.
struct Matrices {
    to_local: [f64; 16],
    to_world: [f64; 16],
    normal: [f64; 16],
}
/// `Vector3.TransformCoordinates`.
fn coordinates(v: V3, m: &[f64; 16]) -> V3 {
    let rx = v.x * m[0] + v.y * m[4] + v.z * m[8] + m[12];
    let ry = v.x * m[1] + v.y * m[5] + v.z * m[9] + m[13];
    let rz = v.x * m[2] + v.y * m[6] + v.z * m[10] + m[14];
    let rw = 1.0 / (v.x * m[3] + v.y * m[7] + v.z * m[11] + m[15]);
    V3 {
        x: rx * rw,
        y: ry * rw,
        z: rz * rw,
    }
}
/// `Vector3.TransformNormal`.
fn direction(v: V3, m: &[f64; 16]) -> V3 {
    V3 {
        x: v.x * m[0] + v.y * m[4] + v.z * m[8],
        y: v.x * m[1] + v.y * m[5] + v.z * m[9],
        z: v.x * m[2] + v.y * m[6] + v.z * m[10],
    }
}
/// `pickingInfo.bu = intersectInfo.bu || 0`.
fn or_zero(value: f64) -> f64 {
    if value == 0.0 || value.is_nan() { 0.0 } else { value }
}
fn vertex(positions: &[f32], index: u32) -> V3 {
    let at = index as usize * 3;
    V3 {
        x: positions[at] as f64,
        y: positions[at + 1] as f64,
        z: positions[at + 2] as f64,
    }
}
fn geometry(positions: &[f32], indices: &[u32]) -> Result<(), u32> {
    if positions.is_empty()
        || !positions.len().is_multiple_of(3)
        || positions.len() / 3 > MAX_VERTICES
        || indices.is_empty()
        || !indices.len().is_multiple_of(3)
        || indices.len() / 3 > MAX_TRIANGLES
        || positions.iter().any(|v| !v.is_finite())
        || indices.iter().any(|i| *i as usize >= positions.len() / 3)
    {
        return Err(GEOMETRY);
    }
    Ok(())
}
/// A snapshot value that must be an integer index below `below`.
fn index(value: f64, below: usize) -> Result<usize, u32> {
    if value >= 0.0 && value < below as f64 && value.fract() == 0.0 {
        Ok(value as usize)
    } else {
        Err(SNAPSHOT)
    }
}

/// IEEE 754-2019 minimum/maximum for finite values: -0 orders below +0, as
/// in Math.min/Math.max and wasm f32x4.min/max, so bounds are order-independent.
fn minimum(a: f32, b: f32) -> f32 {
    if a < b || (a == b && a.is_sign_negative()) { a } else { b }
}
fn maximum(a: f32, b: f32) -> f32 {
    if a > b || (a == b && a.is_sign_positive()) { a } else { b }
}

/// `f64::total_cmp` as an integer, except that -0 equals +0: the reference
/// compares centroids by subtraction, so their tie goes to the lower face.
fn order(value: f64) -> i64 {
    let bits = (value + 0.0).to_bits() as i64;
    bits ^ ((((bits >> 63) as u64) >> 1) as i64)
}

/// Median splits leave at most two distinct sizes per level.
fn node_count(count: usize) -> usize {
    let mut level = [(count, 1_usize), (0, 0)];
    let mut total = 0;
    loop {
        let mut next = [(0_usize, 0_usize); 2];
        for (size, copies) in level {
            if copies == 0 {
                continue;
            }
            total += copies;
            if size > LEAF_SIZE {
                for half in [size / 2, size - size / 2] {
                    let slot = if next[0].1 == 0 || next[0].0 == half { 0 } else { 1 };
                    next[slot] = (half, next[slot].1 + copies);
                }
            }
        }
        if next[0].1 == 0 {
            return total;
        }
        level = next;
    }
}

fn bounds(items: &[Item]) -> ([f32; 3], [f32; 3]) {
    #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
    {
        use core::arch::wasm32::{
            f32x4_extract_lane, f32x4_max, f32x4_min, f32x4_splat, v128, v128_load,
        };
        let mut low = f32x4_splat(f32::INFINITY);
        let mut high = f32x4_splat(f32::NEG_INFINITY);
        for item in items {
            let base = item as *const Item as *const u8;
            // SAFETY: both 16-byte reads stay inside the repr(C) item; the
            // fourth lanes (high.x, face bits) are never extracted.
            let (l, h) = unsafe {
                (
                    v128_load(base.add(core::mem::offset_of!(Item, low)) as *const v128),
                    v128_load(base.add(core::mem::offset_of!(Item, high)) as *const v128),
                )
            };
            low = f32x4_min(low, l);
            high = f32x4_max(high, h);
        }
        (
            [
                f32x4_extract_lane::<0>(low),
                f32x4_extract_lane::<1>(low),
                f32x4_extract_lane::<2>(low),
            ],
            [
                f32x4_extract_lane::<0>(high),
                f32x4_extract_lane::<1>(high),
                f32x4_extract_lane::<2>(high),
            ],
        )
    }
    #[cfg(not(all(target_arch = "wasm32", target_feature = "simd128")))]
    {
        let mut low = [f32::INFINITY; 3];
        let mut high = [f32::NEG_INFINITY; 3];
        for item in items {
            for axis in 0..3 {
                low[axis] = minimum(low[axis], item.low[axis]);
                high[axis] = maximum(high[axis], item.high[axis]);
            }
        }
        (low, high)
    }
}

fn compare<const AXIS: usize>(a: &Item, b: &Item) -> Ordering {
    a.key[AXIS].cmp(&b.key[AXIS]).then(a.face.cmp(&b.face))
}

fn select<const AXIS: usize>(items: &mut [Item], mid: usize) {
    // Unique face IDs make equal centroids deterministic without
    // allocating temporary storage for a stable sort.
    items.select_nth_unstable_by(mid, compare::<AXIS>);
    // The reference sorts every split completely, so a leaf keeps that order.
    if mid <= LEAF_SIZE {
        items[..mid].sort_unstable_by(compare::<AXIS>);
    }
    if items.len() - mid <= LEAF_SIZE {
        items[mid..].sort_unstable_by(compare::<AXIS>);
    }
}

fn split(items: &mut [Item], nodes: &mut Vec<Node>, start: usize, count: usize) -> usize {
    let (low, high) = bounds(&items[start..start + count]);
    let low = V3 {
        x: low[0] as f64,
        y: low[1] as f64,
        z: low[2] as f64,
    };
    let high = V3 {
        x: high[0] as f64,
        y: high[1] as f64,
        z: high[2] as f64,
    };
    let index = nodes.len();
    nodes.push(Node {
        low,
        high,
        left: 0,
        right: 0,
        start,
        count,
    });
    if count > LEAF_SIZE {
        let extent = high.sub(low);
        let mut axis = 0;
        if extent.y > extent.x {
            axis = 1;
        }
        if extent.z > extent.axis(axis) {
            axis = 2;
        }
        let mid = count / 2;
        let range = &mut items[start..start + count];
        match axis {
            0 => select::<0>(range, mid),
            1 => select::<1>(range, mid),
            _ => select::<2>(range, mid),
        }
        let left = split(items, nodes, start, mid);
        let right = split(items, nodes, start + mid, count - mid);
        nodes[index].left = left;
        nodes[index].right = right;
        nodes[index].count = 0;
    }
    index
}

impl Bvh {
    fn build(positions: &[f32], indices: &[u32], available: usize) -> Result<Self, u32> {
        geometry(positions, indices)?;
        let count = indices.len() / 3;
        let node_total = node_count(count);
        // Reserve everything up front: no implicit Vec growth or partially
        // published tree on allocation failure. Items are released after the
        // build, so only the triangles, normals, faces and nodes stay accounted.
        let bytes = count
            .checked_mul(FACE_BYTES)
            .and_then(|n| n.checked_add(node_total.checked_mul(size_of::<Node>())?))
            .ok_or(ALLOCATION)?;
        let peak = count
            .checked_mul(size_of::<Item>())
            .and_then(|n| n.checked_add(bytes))
            .ok_or(ALLOCATION)?;
        if peak > available {
            return Err(ALLOCATION);
        }
        let mut items = Vec::new();
        items.try_reserve_exact(count).map_err(|_| ALLOCATION)?;
        let mut nodes = Vec::new();
        nodes.try_reserve_exact(node_total).map_err(|_| ALLOCATION)?;
        let mut tree = Self::reserve(count)?;
        let corner = |i: u32| {
            let offset = i as usize * 3;
            [positions[offset], positions[offset + 1], positions[offset + 2]]
        };
        for (face, corners) in indices.as_chunks::<3>().0.iter().enumerate() {
            let a = corner(corners[0]);
            let b = corner(corners[1]);
            let c = corner(corners[2]);
            let mut item = Item {
                key: [0; 3],
                low: [0.0; 3],
                high: [0.0; 3],
                face: face as u32,
            };
            for axis in 0..3 {
                item.key[axis] =
                    order((a[axis] as f64 + b[axis] as f64 + c[axis] as f64) / 3.0);
                item.low[axis] = minimum(minimum(a[axis], b[axis]), c[axis]);
                item.high[axis] = maximum(maximum(a[axis], b[axis]), c[axis]);
            }
            items.push(item);
        }
        split(&mut items, &mut nodes, 0, count);
        debug_assert_eq!(nodes.len(), node_total);
        for item in &items {
            tree.push_face(positions, indices, item.face);
        }
        tree.finish(nodes, bytes);
        Ok(tree)
    }

    /// Adopts a snapshot's index as it is: the same nodes, bounds and face
    /// order, so `snapshot()` returns it bit for bit. It must be what
    /// ground-TS's `validateGroundBvh` accepts with the geometry: every node
    /// reached once from the root, a permutation of the faces in the leaves,
    /// finite ordered boxes inside their parents, and every leaf's box
    /// holding its faces' corners. Unused fields (an internal node's start, a
    /// leaf's children) must be indices too, and no leaf may lie deeper than
    /// [`MAX_DEPTH`]. Linear in the snapshot; nothing is sorted.
    fn import(snapshot: &[f64], positions: &[f32], indices: &[u32], available: usize) -> Result<Self, u32> {
        geometry(positions, indices)?;
        let faces = indices.len() / 3;
        if snapshot.len() < 2 {
            return Err(SNAPSHOT);
        }
        let node_total = index(snapshot[0], 2 * faces + 1)?;
        if node_total == 0 || snapshot[1] != faces as f64 || snapshot.len() != 2 + node_total * 10 + faces {
            return Err(SNAPSHOT);
        }
        let bytes = faces
            .checked_mul(FACE_BYTES)
            .and_then(|n| n.checked_add(node_total.checked_mul(size_of::<Node>())?))
            .ok_or(ALLOCATION)?;
        // The seen-node and seen-face flags are released after the import.
        if bytes.checked_add(node_total + faces).is_none_or(|peak| peak > available) {
            return Err(ALLOCATION);
        }
        let zeroed = |len: usize| -> Result<Vec<u8>, u32> {
            let mut v = Vec::new();
            v.try_reserve_exact(len).map_err(|_| ALLOCATION)?;
            v.resize(len, 0);
            Ok(v)
        };
        let mut seen_nodes = zeroed(node_total)?;
        let mut seen_faces = zeroed(faces)?;
        let mut nodes = Vec::new();
        nodes.try_reserve_exact(node_total).map_err(|_| ALLOCATION)?;
        nodes.resize_with(node_total, || Node {
            low: V3::default(),
            high: V3::default(),
            left: 0,
            right: 0,
            start: 0,
            count: 0,
        });
        let mut tree = Self::reserve(faces)?;
        let face_offset = 2 + node_total * 10;
        // [node, parent, depth]; depth-first with one pending sibling per
        // level, so the depth bound also bounds the stack.
        let mut stack = [(0_usize, usize::MAX, 0_usize); STACK];
        let mut size = 1;
        while size > 0 {
            size -= 1;
            let (at, parent, depth) = stack[size];
            if seen_nodes[at] != 0 {
                return Err(SNAPSHOT);
            }
            seen_nodes[at] = 1;
            let v = &snapshot[2 + at * 10..12 + at * 10];
            let low = V3 {
                x: v[0],
                y: v[1],
                z: v[2],
            };
            let high = V3 {
                x: v[3],
                y: v[4],
                z: v[5],
            };
            // Finite and ordered: NaN fails every comparison.
            for axis in 0..3 {
                if !(low.axis(axis) > f64::NEG_INFINITY
                    && low.axis(axis) <= high.axis(axis)
                    && high.axis(axis) < f64::INFINITY)
                {
                    return Err(SNAPSHOT);
                }
            }
            if parent != usize::MAX {
                let outer = &nodes[parent];
                for axis in 0..3 {
                    if low.axis(axis) < outer.low.axis(axis) || high.axis(axis) > outer.high.axis(axis) {
                        return Err(SNAPSHOT);
                    }
                }
            }
            let count = index(v[9], faces + 1)?;
            let start = index(v[8], faces + 1)?;
            let left = index(v[6], node_total)?;
            let right = index(v[7], node_total)?;
            nodes[at] = Node {
                low,
                high,
                left,
                right,
                start,
                count,
            };
            if count == 0 {
                if depth >= MAX_DEPTH || size + 2 > STACK {
                    return Err(SNAPSHOT);
                }
                stack[size] = (right, at, depth + 1);
                stack[size + 1] = (left, at, depth + 1);
                size += 2;
                continue;
            }
            if start + count > faces {
                return Err(SNAPSHOT);
            }
            for slot in start..start + count {
                let face = index(snapshot[face_offset + slot], faces)?;
                if seen_faces[face] != 0 {
                    return Err(SNAPSHOT);
                }
                seen_faces[face] = 1;
                for corner in &indices[face * 3..face * 3 + 3] {
                    let p = vertex(positions, *corner);
                    for axis in 0..3 {
                        // Also false for NaN bounds, which were rejected above.
                        if !(p.axis(axis) >= low.axis(axis) && p.axis(axis) <= high.axis(axis)) {
                            return Err(SNAPSHOT);
                        }
                    }
                }
            }
        }
        // Every face seen once means the leaves' ranges cover every slot once.
        if seen_nodes.contains(&0) || seen_faces.contains(&0) {
            return Err(SNAPSHOT);
        }
        for slot in 0..faces {
            tree.push_face(positions, indices, snapshot[face_offset + slot] as u32);
        }
        tree.finish(nodes, bytes);
        Ok(tree)
    }

    fn reserve(faces: usize) -> Result<Self, u32> {
        let mut triangles = Vec::new();
        triangles.try_reserve_exact(faces).map_err(|_| ALLOCATION)?;
        let mut normals = Vec::new();
        normals.try_reserve_exact(faces).map_err(|_| ALLOCATION)?;
        let mut ids = Vec::new();
        ids.try_reserve_exact(faces).map_err(|_| ALLOCATION)?;
        let zero = V3::default();
        Ok(Self {
            triangles,
            normals,
            faces: ids,
            nodes: Vec::new(),
            bounds: Bounds::of_box(zero, zero),
            bytes: 0,
        })
    }
    fn push_face(&mut self, positions: &[f32], indices: &[u32], face: u32) {
        let at = face as usize * 3;
        let a = vertex(positions, indices[at]);
        let b = vertex(positions, indices[at + 1]);
        let c = vertex(positions, indices[at + 2]);
        self.triangles.push(Triangle::new(a, b, c));
        self.normals.push(a.sub(b).cross(c.sub(b)));
        self.faces.push(face);
    }
    fn finish(&mut self, nodes: Vec<Node>, bytes: usize) {
        self.bounds = Bounds::of_box(nodes[0].low, nodes[0].high);
        self.nodes = nodes;
        self.bytes = bytes;
    }

    fn snapshot_len(&self) -> usize {
        2 + self.nodes.len() * 10 + self.faces.len()
    }
    fn snapshot(&self, values: &mut [f64]) {
        values[0] = self.nodes.len() as f64;
        values[1] = self.faces.len() as f64;
        for (index, node) in self.nodes.iter().enumerate() {
            values[2 + index * 10..2 + (index + 1) * 10].copy_from_slice(&[
                node.low.x, node.low.y, node.low.z, node.high.x, node.high.y, node.high.z,
                node.left as f64, node.right as f64, node.start as f64, node.count as f64,
            ]);
        }
        let offset = 2 + self.nodes.len() * 10;
        for (index, face) in self.faces.iter().enumerate() {
            values[offset + index] = *face as f64;
        }
    }

    /// The nearest hit along a mesh-space ray, ties to the lowest face. It
    /// reaches every face whose hit is no farther than its best, so the
    /// order it visits nodes in does not change the answer.
    fn cast(&self, origin: V3, direction: V3, length: f64, epsilon: f64) -> Option<Hit> {
        let mut best = length;
        let mut hit: Option<Hit> = None;
        // [node, where the segment enters its box].
        let mut stack = [(0_usize, 0.0_f64); STACK];
        let mut size = 0;
        if let Some(near) = enter(&self.nodes[0], origin, direction, best, epsilon) {
            stack[0] = (0, near);
            size = 1;
        }
        while size > 0 {
            size -= 1;
            let (at, near) = stack[size];
            // The box test again with the current best, the only bound that
            // has moved since the push.
            if near > best {
                continue;
            }
            let node = &self.nodes[at];
            if node.count == 0 {
                let (left, right) = (node.left, node.right);
                let [l, r] = enter_pair(&self.nodes[left], &self.nodes[right], origin, direction, best, epsilon);
                // The nearer child is searched first, so it tightens the best sooner.
                match (l, r) {
                    (Some(a), Some(b)) => {
                        let (first, second) = if a <= b { ((left, a), (right, b)) } else { ((right, b), (left, a)) };
                        stack[size] = second;
                        stack[size + 1] = first;
                        size += 2;
                    }
                    (Some(a), None) => {
                        stack[size] = (left, a);
                        size += 1;
                    }
                    (None, Some(b)) => {
                        stack[size] = (right, b);
                        size += 1;
                    }
                    (None, None) => {}
                }
                continue;
            }
            for slot in node.start..node.start + node.count {
                let Some((distance, bu, bv)) =
                    intersect_triangle(&self.triangles[slot], origin, direction, length, epsilon)
                else {
                    continue;
                };
                let face = self.faces[slot];
                if distance < best || (distance == best && hit.as_ref().is_none_or(|h| face < h.face)) {
                    best = distance;
                    hit = Some(Hit {
                        distance,
                        slot,
                        face,
                        bu,
                        bv,
                    });
                }
            }
        }
        hit
    }

    fn query(&self, rays: &[f64], output: &mut [f64]) -> Result<(), u32> {
        if rays.is_empty()
            || !rays.len().is_multiple_of(8)
            || rays.len() / 8 > MAX_RAYS
            || output.len() != rays.len()
            || rays.as_chunks::<8>().0.iter().any(|ray| {
                ray.iter().any(|v| !v.is_finite())
                    || ray[3] <= 0.0
                    || ray[7] < 0.0
                    || (ray[4] == 0.0 && ray[5] == 0.0 && ray[6] == 0.0)
            })
        {
            return Err(RAYS);
        }
        for (ray, result) in rays.as_chunks::<8>().0.iter().zip(output.as_chunks_mut::<8>().0) {
            let origin = V3 {
                x: ray[0],
                y: ray[1],
                z: ray[2],
            };
            let direction = V3 {
                x: ray[4],
                y: ray[5],
                z: ray[6],
            };
            // [hit, local-ray parameter, original face, bu, bv, raw normal xyz].
            *result = match self.cast(origin, direction, ray[3], ray[7]) {
                None => [0.0, -1.0, -1.0, 0.0, 0.0, 0.0, 0.0, 0.0],
                Some(hit) => {
                    let t = &self.triangles[hit.slot];
                    let n = t.edge1.cross(t.edge2);
                    [1.0, hit.distance, hit.face as f64, hit.bu, hit.bv, n.x, n.y, n.z]
                }
            };
        }
        Ok(())
    }

    /// Babylon's pick of this mesh for each world ray, as `scene.pickWithRay`
    /// and `getNormal(true, false)` make it; a row changes only for a hit
    /// nearer than the one it holds, as the scene keeps its first mesh on a
    /// tie. Rays `[origin xyz, direction xyz, length, epsilon]`; rows `[mesh,
    /// world distance, face, bu, bv, point xyz, unit normal xyz]`, mesh 0 for
    /// none.
    fn world(&self, mesh: u32, m: &Matrices, rays: &[f64], output: &mut [f64]) {
        for (ray, row) in rays.as_chunks::<RAY>().0.iter().zip(output.as_chunks_mut::<WORLD_ROW>().0) {
            let world_direction = V3 {
                x: ray[3],
                y: ray[4],
                z: ray[5],
            };
            // Ray.TransformToRef(ray, worldToLocal).
            let origin = coordinates(
                V3 {
                    x: ray[0],
                    y: ray[1],
                    z: ray[2],
                },
                &m.to_local,
            );
            let mut local = direction(world_direction, &m.to_local);
            let mut length = ray[6];
            let len = local.length();
            if !(len == 0.0 || len == 1.0) {
                local = local.scale(1.0 / len);
                length *= len;
            }
            // AbstractMesh.intersects: bounding sphere, box, then triangles.
            if !self.bounds.sphere(origin, local) || !self.bounds.boxed(origin, local) {
                continue;
            }
            let Some(hit) = self.cast(origin, local, length, ray[7]) else {
                continue;
            };
            let world_origin = coordinates(origin, &m.to_world);
            let step = direction(local.scale(hit.distance), &m.to_world);
            let point = V3 {
                x: step.x + world_origin.x,
                y: step.y + world_origin.y,
                z: step.z + world_origin.z,
            };
            let distance = world_origin.sub(point).length();
            if row[0] != 0.0 && distance >= row[1] {
                continue;
            }
            let mut normal = direction(self.normals[hit.slot], &m.normal);
            // Flipped to face the ray when the ray runs along it.
            if normal.dot(world_direction) > 0.0 {
                normal = normal.scale(-1.0);
            }
            let normal = normal.normalized();
            *row = [
                mesh as f64,
                distance,
                hit.face as f64,
                or_zero(hit.bu),
                or_zero(hit.bv),
                point.x,
                point.y,
                point.z,
                normal.x,
                normal.y,
                normal.z,
            ];
        }
    }
}

/// Where the segment `[0, far]` enters a node's box, or `None` if it misses.
/// Babylon's triangle epsilon admits points slightly outside a face; the
/// aggregate width bounds both edge terms, and 1 mm covers roundoff. A box
/// that pads to a non-finite bound is entered at 0.
fn enter(node: &Node, origin: V3, direction: V3, far: f64, epsilon: f64) -> Option<f64> {
    let mut near: f64 = 0.0;
    let mut far = far;
    for axis in 0..3 {
        let padding = 0.001 + 2.0 * epsilon * (node.high.axis(axis) - node.low.axis(axis));
        let low = node.low.axis(axis) - padding;
        let high = node.high.axis(axis) + padding;
        let o = origin.axis(axis);
        let d = direction.axis(axis);
        if !low.is_finite() || !high.is_finite() {
            return Some(0.0);
        }
        if d == 0.0 {
            if o < low || o > high {
                return None;
            }
            continue;
        }
        let a = (low - o) / d;
        let b = (high - o) / d;
        near = near.max(a.min(b));
        far = far.min(a.max(b));
        if near > far {
            return None;
        }
    }
    Some(near)
}

/// [`enter`] for two sibling boxes at once, one per f64x2 lane: the same
/// operations and the same answers, signed zeros of the entry aside.
#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
fn enter_pair(a: &Node, b: &Node, origin: V3, direction: V3, far: f64, epsilon: f64) -> [Option<f64>; 2] {
    use core::arch::wasm32::{
        f64x2, f64x2_abs, f64x2_add, f64x2_div, f64x2_extract_lane, f64x2_gt, f64x2_lt, f64x2_max,
        f64x2_min, f64x2_mul, f64x2_splat, f64x2_sub, i64x2_bitmask, i64x2_splat, v128_and,
        v128_andnot, v128_not, v128_or,
    };
    let millimetre = f64x2_splat(0.001);
    let twice = f64x2_splat(2.0 * epsilon);
    let infinity = f64x2_splat(f64::INFINITY);
    let mut near = f64x2_splat(0.0);
    let mut far = f64x2_splat(far);
    // Lanes already answered, and those answered by a non-finite bound.
    let mut decided = i64x2_splat(0);
    let mut reach = i64x2_splat(0);
    for axis in 0..3 {
        let low = f64x2(a.low.axis(axis), b.low.axis(axis));
        let high = f64x2(a.high.axis(axis), b.high.axis(axis));
        let padding = f64x2_add(millimetre, f64x2_mul(twice, f64x2_sub(high, low)));
        let low = f64x2_sub(low, padding);
        let high = f64x2_add(high, padding);
        let finite = v128_and(f64x2_lt(f64x2_abs(low), infinity), f64x2_lt(f64x2_abs(high), infinity));
        let o = f64x2_splat(origin.axis(axis));
        let d = direction.axis(axis);
        let miss = if d == 0.0 {
            v128_or(f64x2_lt(o, low), f64x2_gt(o, high))
        } else {
            let d = f64x2_splat(d);
            let t0 = f64x2_div(f64x2_sub(low, o), d);
            let t1 = f64x2_div(f64x2_sub(high, o), d);
            near = f64x2_max(near, f64x2_min(t0, t1));
            far = f64x2_min(far, f64x2_max(t0, t1));
            f64x2_gt(near, far)
        };
        let fresh = v128_andnot(v128_or(v128_not(finite), miss), decided);
        reach = v128_or(reach, v128_andnot(fresh, finite));
        decided = v128_or(decided, fresh);
    }
    let pass = i64x2_bitmask(v128_or(reach, v128_not(decided)));
    let reached = i64x2_bitmask(reach);
    let lane = |bit: u8, value: f64| (pass & bit != 0).then_some(if reached & bit != 0 { 0.0 } else { value });
    [lane(1, f64x2_extract_lane::<0>(near)), lane(2, f64x2_extract_lane::<1>(near))]
}
#[cfg(not(all(target_arch = "wasm32", target_feature = "simd128")))]
fn enter_pair(a: &Node, b: &Node, origin: V3, direction: V3, far: f64, epsilon: f64) -> [Option<f64>; 2] {
    [enter(a, origin, direction, far, epsilon), enter(b, origin, direction, far, epsilon)]
}

/// `Ray.intersectsTriangle` on the precomputed edges, plus `_intersectTriangles`'s
/// rejection of negative distances and, as ground-TS, of non-finite ones.
fn intersect_triangle(
    triangle: &Triangle,
    origin: V3,
    direction: V3,
    length: f64,
    epsilon: f64,
) -> Option<(f64, f64, f64)> {
    let pvec = direction.cross(triangle.edge2);
    let det = triangle.edge1.dot(pvec);
    if det == 0.0 {
        return None;
    }
    let invdet = 1.0 / det;
    let tvec = origin.sub(triangle.origin);
    let bv = tvec.dot(pvec) * invdet;
    if bv < -epsilon || bv > 1.0 + epsilon {
        return None;
    }
    let qvec = tvec.cross(triangle.edge1);
    let bw = direction.dot(qvec) * invdet;
    if bw < -epsilon || bv + bw > 1.0 + epsilon {
        return None;
    }
    let distance = triangle.edge2.dot(qvec) * invdet;
    if !distance.is_finite() || distance > length || distance < 0.0 {
        return None;
    }
    Some((distance, 1.0 - bv - bw, bv))
}

enum Buffer {
    F32(Vec<f32>),
    U32(Vec<u32>),
    F64(Vec<f64>),
}
impl Buffer {
    fn pointer(&self) -> usize {
        match self {
            Self::F32(v) => v.as_ptr() as usize,
            Self::U32(v) => v.as_ptr() as usize,
            Self::F64(v) => v.as_ptr() as usize,
        }
    }
    fn len(&self) -> usize {
        match self {
            Self::F32(v) => v.len(),
            Self::U32(v) => v.len(),
            Self::F64(v) => v.len(),
        }
    }
    fn kind(&self) -> u32 {
        match self {
            Self::F32(_) => 1,
            Self::U32(_) => 2,
            Self::F64(_) => 3,
        }
    }
    fn bytes(&self) -> usize {
        self.len() * if self.kind() == 3 { 8 } else { 4 }
    }
}
#[derive(Default)]
struct Registry {
    buffers: Vec<Buffer>,
    meshes: Vec<(u32, Bvh)>,
    bytes: usize,
    next_mesh: u32,
    error: u32,
}
/// A read-only buffer and a distinct writable one.
fn pair(buffers: &mut [Buffer], read: usize, write: usize) -> (&Buffer, &mut Buffer) {
    if read < write {
        let (left, right) = buffers.split_at_mut(write);
        (&left[read], &mut right[0])
    } else {
        let (left, right) = buffers.split_at_mut(read);
        (&right[0], &mut left[write])
    }
}
impl Registry {
    fn alloc(&mut self, kind: u32, length: u32) -> usize {
        let len = length as usize;
        let size = match kind {
            1 | 2 => 4,
            3 => 8,
            _ => {
                self.error = INVALID;
                return 0;
            }
        };
        let Some(bytes) = len.checked_mul(size) else {
            self.error = ALLOCATION;
            return 0;
        };
        if len == 0
            || self.buffers.len() >= MAX_BUFFERS
            || bytes > MAX_BYTES.saturating_sub(self.bytes)
            || self.buffers.try_reserve(1).is_err()
        {
            self.error = ALLOCATION;
            return 0;
        }
        macro_rules! make {
            ($ty:ty,$variant:ident,$zero:expr) => {{
                let mut v = Vec::<$ty>::new();
                if v.try_reserve_exact(len).is_err() {
                    self.error = ALLOCATION;
                    return 0;
                }
                v.resize(len, $zero);
                Buffer::$variant(v)
            }};
        }
        let buffer = match kind {
            1 => make!(f32, F32, 0.0),
            2 => make!(u32, U32, 0),
            _ => make!(f64, F64, 0.0),
        };
        let pointer = buffer.pointer();
        self.buffers.push(buffer);
        self.bytes += bytes;
        self.error = 0;
        pointer
    }
    fn position(&self, pointer: usize, kind: u32, len: u32) -> Result<usize, u32> {
        self.buffers
            .iter()
            .position(|b| b.pointer() == pointer && b.kind() == kind && b.len() == len as usize)
            .ok_or(INVALID)
    }
    fn buffer(&self, pointer: usize, kind: u32, len: u32) -> Result<&Buffer, u32> {
        Ok(&self.buffers[self.position(pointer, kind, len)?])
    }
    fn mesh(&self, mesh: u32) -> Result<usize, u32> {
        self.meshes.iter().position(|(id, _)| *id == mesh).ok_or(MESH)
    }
    fn geometry(
        &self,
        positions: usize,
        position_len: u32,
        indices: usize,
        index_len: u32,
    ) -> Result<(&[f32], &[u32]), u32> {
        let Buffer::F32(p) = self.buffer(positions, 1, position_len)? else {
            return Err(INVALID);
        };
        let Buffer::U32(i) = self.buffer(indices, 2, index_len)? else {
            return Err(INVALID);
        };
        Ok((p, i))
    }
    /// Room for one more mesh, checked before any work for it.
    fn admit(&mut self) -> Result<(), u32> {
        if self.meshes.len() >= MAX_MESHES
            || self.next_mesh == u32::MAX
            || self.meshes.try_reserve(1).is_err()
        {
            return Err(ALLOCATION);
        }
        Ok(())
    }
    fn publish(&mut self, tree: Bvh) -> u32 {
        self.next_mesh += 1;
        let id = self.next_mesh;
        self.bytes += tree.bytes;
        self.meshes.push((id, tree));
        id
    }
    fn build(
        &mut self,
        positions: usize,
        position_len: u32,
        indices: usize,
        index_len: u32,
    ) -> Result<u32, u32> {
        self.admit()?;
        let (p, i) = self.geometry(positions, position_len, indices, index_len)?;
        let tree = Bvh::build(p, i, MAX_BYTES.saturating_sub(self.bytes))?;
        Ok(self.publish(tree))
    }
    fn import(
        &mut self,
        snapshot: usize,
        snapshot_len: u32,
        positions: usize,
        position_len: u32,
        indices: usize,
        index_len: u32,
    ) -> Result<u32, u32> {
        self.admit()?;
        let Buffer::F64(s) = self.buffer(snapshot, 3, snapshot_len)? else {
            return Err(INVALID);
        };
        let (p, i) = self.geometry(positions, position_len, indices, index_len)?;
        let tree = Bvh::import(s, p, i, MAX_BYTES.saturating_sub(self.bytes))?;
        Ok(self.publish(tree))
    }
    fn set_bounds(&mut self, mesh: u32, pointer: usize, len: u32) -> Result<(), u32> {
        let at = self.mesh(mesh)?;
        let Buffer::F64(v) = self.buffer(pointer, 3, len)? else {
            return Err(INVALID);
        };
        if v.len() != 10 {
            return Err(INVALID);
        }
        let point = |at: usize| V3 {
            x: v[at],
            y: v[at + 1],
            z: v[at + 2],
        };
        let bounds = Bounds {
            minimum: point(0),
            maximum: point(3),
            center: point(6),
            radius: v[9],
        };
        if v.iter().any(|x| !x.is_finite())
            || (0..3).any(|axis| bounds.minimum.axis(axis) > bounds.maximum.axis(axis))
            || bounds.radius < 0.0
        {
            return Err(GEOMETRY);
        }
        self.meshes[at].1.bounds = bounds;
        Ok(())
    }
    fn query(
        &mut self,
        mesh: u32,
        rays_ptr: usize,
        rays_len: u32,
        output_ptr: usize,
        output_len: u32,
    ) -> Result<(), u32> {
        if rays_ptr == output_ptr {
            return Err(INVALID);
        }
        let at = self.mesh(mesh)?;
        let rays_index = self.position(rays_ptr, 3, rays_len)?;
        let output_index = self.position(output_ptr, 3, output_len)?;
        let (Buffer::F64(rays), Buffer::F64(output)) = pair(&mut self.buffers, rays_index, output_index)
        else {
            return Err(INVALID);
        };
        self.meshes[at].1.query(rays, output)
    }
    #[allow(clippy::too_many_arguments)]
    fn world(
        &mut self,
        mesh: u32,
        matrices_ptr: usize,
        matrices_len: u32,
        rays_ptr: usize,
        rays_len: u32,
        output_ptr: usize,
        output_len: u32,
        count: u32,
    ) -> Result<(), u32> {
        if output_ptr == rays_ptr || output_ptr == matrices_ptr {
            return Err(INVALID);
        }
        let at = self.mesh(mesh)?;
        let Buffer::F64(values) = self.buffer(matrices_ptr, 3, matrices_len)? else {
            return Err(INVALID);
        };
        if values.len() != 32 && values.len() != 48 {
            return Err(INVALID);
        }
        if values.iter().any(|v| !v.is_finite()) {
            return Err(TRANSFORM);
        }
        let matrix = |at: usize| -> [f64; 16] { values[at..at + 16].try_into().unwrap() };
        let m = Matrices {
            to_local: matrix(0),
            to_world: matrix(16),
            normal: matrix(if values.len() == 48 { 32 } else { 16 }),
        };
        let count = count as usize;
        let rays_index = self.position(rays_ptr, 3, rays_len)?;
        let output_index = self.position(output_ptr, 3, output_len)?;
        let (Buffer::F64(rays), Buffer::F64(output)) = pair(&mut self.buffers, rays_index, output_index)
        else {
            return Err(INVALID);
        };
        if count == 0 || count > MAX_RAYS || rays.len() < count * RAY || output.len() < count * WORLD_ROW {
            return Err(RAYS);
        }
        let (rays, output) = (&rays[..count * RAY], &mut output[..count * WORLD_ROW]);
        if rays.as_chunks::<RAY>().0.iter().any(|ray| {
            ray.iter().any(|v| !v.is_finite())
                || (ray[3] == 0.0 && ray[4] == 0.0 && ray[5] == 0.0)
                || ray[6] <= 0.0
                || ray[7] < 0.0
        }) || output.as_chunks::<WORLD_ROW>().0.iter().any(|row| {
            // Empty, or a hit on some mesh.
            row[0] != 0.0 && !(row[0] >= 1.0 && row[0] <= u32::MAX as f64 && row[0].fract() == 0.0)
        }) {
            return Err(RAYS);
        }
        self.meshes[at].1.world(mesh, &m, rays, output);
        Ok(())
    }
}
thread_local! { static REGISTRY: RefCell<Registry> = RefCell::new(Registry::default()); }
fn with<T>(failure: T, run: impl FnOnce(&mut Registry) -> T) -> T {
    REGISTRY.with(|r| match r.try_borrow_mut() {
        Ok(mut r) => run(&mut r),
        Err(_) => failure,
    })
}
/// A new mesh's handle, or 0 with the reason in `ground_last_error`.
fn handle(r: &mut Registry, result: Result<u32, u32>) -> u32 {
    match result {
        Ok(id) => {
            r.error = 0;
            id
        }
        Err(e) => {
            r.error = e;
            0
        }
    }
}
#[unsafe(no_mangle)]
pub extern "C" fn ground_abi_version() -> u32 {
    1
}
#[unsafe(no_mangle)]
pub extern "C" fn ground_last_error() -> u32 {
    with(INVALID, |r| r.error)
}
#[unsafe(no_mangle)]
pub extern "C" fn ground_alloc(kind: u32, len: u32) -> usize {
    with(0, |r| r.alloc(kind, len))
}
#[unsafe(no_mangle)]
pub extern "C" fn ground_free(pointer: usize, kind: u32, len: u32) -> u32 {
    with(INVALID, |r| {
        let Ok(i) = r.position(pointer, kind, len) else {
            return INVALID;
        };
        let buffer = r.buffers.swap_remove(i);
        r.bytes -= buffer.bytes();
        0
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn ground_build(
    positions: usize,
    position_len: u32,
    indices: usize,
    index_len: u32,
) -> u32 {
    with(0, |r| {
        let result = r.build(positions, position_len, indices, index_len);
        handle(r, result)
    })
}
/// Adopts `ground_snapshot`'s layout for these positions and indices without
/// rebuilding: `[nodes, faces, nodes × [low xyz, high xyz, left, right,
/// start, count], faces in leaf order]`. Error 6 if it is not a valid index
/// of this geometry.
#[unsafe(no_mangle)]
pub extern "C" fn ground_import_snapshot(
    snapshot: usize,
    snapshot_len: u32,
    positions: usize,
    position_len: u32,
    indices: usize,
    index_len: u32,
) -> u32 {
    with(0, |r| {
        let result = r.import(snapshot, snapshot_len, positions, position_len, indices, index_len);
        handle(r, result)
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn ground_release(mesh: u32) -> u32 {
    with(INVALID, |r| {
        let Ok(index) = r.mesh(mesh) else {
            return MESH;
        };
        let (_, tree) = r.meshes.swap_remove(index);
        r.bytes -= tree.bytes;
        0
    })
}
/// The mesh-space `BoundingInfo` world batches test first, `[minimum xyz,
/// maximum xyz, sphere center xyz, sphere radius]`; the root box and its
/// sphere until set.
#[unsafe(no_mangle)]
pub extern "C" fn ground_set_bounds(mesh: u32, bounds: usize, bounds_len: u32) -> u32 {
    with(INVALID, |r| r.set_bounds(mesh, bounds, bounds_len).err().unwrap_or(0))
}
#[unsafe(no_mangle)]
pub extern "C" fn ground_query(
    mesh: u32,
    rays: usize,
    rays_len: u32,
    output: usize,
    output_len: u32,
) -> u32 {
    with(INVALID, |r| {
        r.query(mesh, rays, rays_len, output, output_len)
            .err()
            .unwrap_or(0)
    })
}
/// Picks `count` world rays against one mesh. Matrices `[world to mesh 16,
/// mesh to world 16, normal to world 16?]` in Babylon's `Matrix.m` order;
/// the normal matrix defaults to mesh to world. Rays `[origin xyz, direction
/// xyz, length, epsilon]`; rows `[mesh, world distance, face, bu, bv, point
/// xyz, normal xyz]` keep the nearest hit across calls, so a batch runs over
/// the scene's meshes in order. Error 7 for a non-finite matrix.
#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn ground_query_world_batch(
    mesh: u32,
    matrices: usize,
    matrices_len: u32,
    rays: usize,
    rays_len: u32,
    output: usize,
    output_len: u32,
    count: u32,
) -> u32 {
    with(INVALID, |r| {
        r.world(mesh, matrices, matrices_len, rays, rays_len, output, output_len, count)
            .err()
            .unwrap_or(0)
    })
}

/// Immutable traversal data for a synchronous host reader. Geometry remains
/// owned by the host; no WASM pointer escapes this explicit owned copy.
#[unsafe(no_mangle)]
pub extern "C" fn ground_snapshot_len(mesh: u32) -> u32 {
    with(0, |r| {
        let Ok(at) = r.mesh(mesh) else {
            r.error = MESH;
            return 0;
        };
        r.meshes[at].1.snapshot_len() as u32
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn ground_snapshot(mesh: u32, output: usize, output_len: u32) -> u32 {
    with(INVALID, |r| {
        let Ok(at) = r.mesh(mesh) else {
            return MESH;
        };
        let tree = &r.meshes[at].1;
        let Some(Buffer::F64(values)) = r.buffers.iter_mut().find(|b| {
            b.pointer() == output && b.kind() == 3 && b.len() == output_len as usize
        }) else {
            return INVALID;
        };
        if values.len() != tree.snapshot_len() {
            return INVALID;
        }
        tree.snapshot(values);
        0
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn splits(count: usize) -> usize {
        if count > LEAF_SIZE {
            1 + splits(count / 2) + splits(count - count / 2)
        } else {
            1
        }
    }

    #[test]
    fn node_count_matches_median_splits() {
        // The build reserves exactly this many nodes before splitting.
        for count in (1..=20_000).chain([65_535, 65_536, 131_071, 262_143, MAX_TRIANGLES]) {
            assert_eq!(node_count(count), splits(count), "{count} triangles");
        }
    }

    /// A bumpy `n × n` grid of quads, two faces each.
    fn grid(n: usize) -> (Vec<f32>, Vec<u32>) {
        let mut positions = Vec::new();
        for j in 0..=n {
            for i in 0..=n {
                let (x, z) = (i as f32 - n as f32 / 2.0, j as f32 - n as f32 / 2.0);
                positions.extend([x, ((i * 7 + j * 13) % 5) as f32 * 0.25, z]);
            }
        }
        let mut indices = Vec::new();
        let at = |i: usize, j: usize| (j * (n + 1) + i) as u32;
        for j in 0..n {
            for i in 0..n {
                indices.extend([at(i, j), at(i + 1, j), at(i + 1, j + 1)]);
                indices.extend([at(i, j), at(i + 1, j + 1), at(i, j + 1)]);
            }
        }
        (positions, indices)
    }
    fn snapshot(tree: &Bvh) -> Vec<f64> {
        let mut values = vec![0.0; tree.snapshot_len()];
        tree.snapshot(&mut values);
        values
    }
    fn same(a: &[f64], b: &[f64]) -> bool {
        a.len() == b.len() && a.iter().zip(b).all(|(x, y)| x.to_bits() == y.to_bits())
    }
    fn rays(count: usize) -> Vec<f64> {
        // Local rays [origin xyz, length, direction xyz, epsilon], mostly
        // down, some grazing and some missing.
        (0..count)
            .flat_map(|k| {
                let s = k as f64;
                let x = (s * 0.618_034).fract() * 20.0 - 10.0;
                let z = (s * 0.414_214).fract() * 20.0 - 10.0;
                let dx = [0.0, 0.3, -1.0, 1e-8][k % 4];
                [x, 5.0, z, [10.0, 4.9, 100.0][k % 3], dx, -1.0, 0.2, [0.0, 1e-6, 0.001][k % 3]]
            })
            .collect()
    }

    #[test]
    fn import_round_trips_and_queries_alike() {
        let (positions, indices) = grid(16);
        let built = Bvh::build(&positions, &indices, MAX_BYTES).unwrap();
        let values = snapshot(&built);
        let imported = Bvh::import(&values, &positions, &indices, MAX_BYTES).unwrap();
        assert!(same(&values, &snapshot(&imported)));
        assert_eq!(built.bytes, imported.bytes);
        let rays = rays(512);
        let (mut a, mut b) = (vec![0.0; rays.len()], vec![0.0; rays.len()]);
        built.query(&rays, &mut a).unwrap();
        imported.query(&rays, &mut b).unwrap();
        assert!(same(&a, &b));
        assert!(a.as_chunks::<8>().0.iter().filter(|r| r[0] == 1.0).count() > 100);
    }

    #[test]
    fn import_rejects_invalid_indexes() {
        let (positions, indices) = grid(8);
        let values = snapshot(&Bvh::build(&positions, &indices, MAX_BYTES).unwrap());
        let nodes = values[0] as usize;
        let faces = 2 + nodes * 10;
        let reject = |name: &str, edit: &dyn Fn(&mut Vec<f64>)| {
            let mut v = values.clone();
            edit(&mut v);
            assert_eq!(Bvh::import(&v, &positions, &indices, MAX_BYTES).err(), Some(SNAPSHOT), "{name}");
        };
        let internal = (0..nodes).find(|&k| values[2 + k * 10 + 9] == 0.0).unwrap();
        let leaf = (0..nodes).find(|&k| values[2 + k * 10 + 9] > 1.0).unwrap();
        reject("node count", &|v| v[0] += 1.0);
        reject("face count", &|v| v[1] -= 1.0);
        reject("length", &|v| v.truncate(v.len() - 1));
        reject("NaN bound", &|v| v[2 + leaf * 10] = f64::NAN);
        reject("inverted bound", &|v| v[2 + leaf * 10] = v[2 + leaf * 10 + 3] + 1.0);
        reject("outside parent", &|v| v[2 + leaf * 10 + 4] += 100.0);
        reject("duplicate face", &|v| v[faces + 1] = v[faces]);
        reject("cycle", &|v| v[2 + internal * 10 + 7] = 0.0);
        reject("shared child", &|v| v[2 + internal * 10 + 7] = v[2 + internal * 10 + 6]);
        reject("fractional child", &|v| v[2 + internal * 10 + 6] += 0.5);
        reject("fractional face", &|v| v[faces] += 0.5);
        reject("leaf range", &|v| v[2 + leaf * 10 + 8] = (indices.len() / 3) as f64);
        // A tighter leaf box that leaves out a corner.
        let shrink = |v: &mut Vec<f64>| v[2 + leaf * 10 + 3] = v[2 + leaf * 10];
        reject("corner outside leaf", &shrink);
        assert_eq!(Bvh::import(&values, &positions, &[], MAX_BYTES).err(), Some(GEOMETRY));
    }

    #[test]
    fn import_bounds_depth() {
        // A caterpillar: each internal node has a one-face leaf and the rest.
        let faces = MAX_DEPTH + 2;
        let positions: Vec<f32> = (0..faces).flat_map(|k| [k as f32, 0.0, 0.0, k as f32 + 0.5, 0.0, 1.0, k as f32, 0.0, 1.0]).collect();
        let indices: Vec<u32> = (0..faces as u32 * 3).collect();
        let caterpillar = |depth: usize| {
            // Nodes: spine 0..depth, leaves after; the last spine node splits into two leaves.
            let mut nodes: Vec<[f64; 10]> = Vec::new();
            let spine = depth;
            for k in 0..spine {
                let low = k as f64;
                nodes.push([low, 0.0, 0.0, faces as f64, 0.0, 1.0, 0.0, 0.0, k as f64, 0.0]);
            }
            let leaf = |face: usize, count: usize| [face as f64, 0.0, 0.0, faces as f64, 0.0, 1.0, 0.0, 0.0, face as f64, count as f64];
            for k in 0..spine {
                let leaf_at = nodes.len();
                nodes.push(leaf(k, 1));
                nodes[k][6] = leaf_at as f64;
            }
            let rest = nodes.len();
            nodes.push(leaf(spine, faces - spine));
            for (k, node) in nodes.iter_mut().enumerate().take(spine) {
                node[7] = if k + 1 < spine { (k + 1) as f64 } else { rest as f64 };
            }
            let mut v = vec![nodes.len() as f64, faces as f64];
            v.extend(nodes.iter().flatten());
            v.extend((0..faces).map(|f| f as f64));
            v
        };
        let ok = caterpillar(MAX_DEPTH);
        let tree = Bvh::import(&ok, &positions, &indices, MAX_BYTES).unwrap();
        assert!(same(&ok, &snapshot(&tree)));
        let rays: Vec<f64> = (0..faces).flat_map(|k| [k as f64 + 0.1, 1.0, 0.7, 2.0, 0.0, -1.0, 0.0, 0.0]).collect();
        let mut output = vec![0.0; rays.len()];
        tree.query(&rays, &mut output).unwrap();
        for (k, row) in output.as_chunks::<8>().0.iter().enumerate() {
            assert_eq!((row[0], row[2]), (1.0, k as f64));
        }
        assert_eq!(Bvh::import(&caterpillar(MAX_DEPTH + 1), &positions, &indices, MAX_BYTES).err(), Some(SNAPSHOT));
    }

    #[test]
    fn import_and_build_account_alike() {
        let (positions, indices) = grid(8);
        let built = Bvh::build(&positions, &indices, MAX_BYTES).unwrap();
        let values = snapshot(&built);
        assert_eq!(Bvh::import(&values, &positions, &indices, built.bytes).err(), Some(ALLOCATION));
        assert!(Bvh::import(&values, &positions, &indices, built.bytes + values[0] as usize + indices.len() / 3).is_ok());
    }

    const IDENTITY: [f64; 16] = [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0];

    #[test]
    fn world_batch_with_identity_matches_the_local_query() {
        let (positions, indices) = grid(16);
        let tree = Bvh::build(&positions, &indices, MAX_BYTES).unwrap();
        // World rays with unit directions, and the mesh-space rays
        // Ray.TransformToRef makes of them under the identity.
        let world: Vec<f64> = rays(512)
            .as_chunks::<8>()
            .0
            .iter()
            .flat_map(|r| {
                let len = (r[4] * r[4] + r[5] * r[5] + r[6] * r[6]).sqrt();
                [r[0], r[1], r[2], r[4] / len, r[5] / len, r[6] / len, r[3] * len, r[7]]
            })
            .collect();
        let local: Vec<f64> = world
            .as_chunks::<8>()
            .0
            .iter()
            .flat_map(|r| {
                let d = V3 { x: r[3], y: r[4], z: r[5] };
                let len = d.length();
                let (d, length) = if len == 0.0 || len == 1.0 { (d, r[6]) } else { (d.scale(1.0 / len), r[6] * len) };
                [r[0], r[1], r[2], length, d.x, d.y, d.z, r[7]]
            })
            .collect();
        let mut expected = vec![0.0; local.len()];
        tree.query(&local, &mut expected).unwrap();
        let m = Matrices {
            to_local: IDENTITY,
            to_world: IDENTITY,
            normal: IDENTITY,
        };
        let mut output = vec![0.0; 512 * WORLD_ROW];
        tree.world(9, &m, &world, &mut output);
        let mut hits = 0;
        for ((ray, want), row) in world.as_chunks::<8>().0.iter().zip(expected.as_chunks::<8>().0).zip(output.as_chunks::<WORLD_ROW>().0) {
            if want[0] == 0.0 {
                assert_eq!(row[0], 0.0);
                continue;
            }
            hits += 1;
            // A unit world direction is used as it is, so the face and its
            // barycentrics are the local query's.
            assert_eq!((row[0], row[2], row[3], row[4]), (9.0, want[2], want[3], want[4]));
            let point = [ray[0] + ray[3] * row[1], ray[1] + ray[4] * row[1], ray[2] + ray[5] * row[1]];
            for axis in 0..3 {
                assert!((point[axis] - row[5 + axis]).abs() < 1e-9);
            }
            let n = V3 {
                x: row[8],
                y: row[9],
                z: row[10],
            };
            assert!((n.length() - 1.0).abs() < 1e-12);
            assert!(n.dot(V3 { x: ray[3], y: ray[4], z: ray[5] }) <= 0.0);
        }
        assert!(hits > 100);
    }

    #[test]
    fn world_batch_keeps_the_nearer_hit() {
        let (positions, indices) = grid(4);
        let tree = Bvh::build(&positions, &indices, MAX_BYTES).unwrap();
        let ray = [0.3, 5.0, 0.2, 0.0, -1.0, 0.0, 100.0, 0.0];
        let lift = |dy: f64| {
            let mut to_world = IDENTITY;
            to_world[13] = dy;
            let mut to_local = IDENTITY;
            to_local[13] = -dy;
            Matrices {
                to_local,
                to_world,
                normal: to_world,
            }
        };
        let mut row = [0.0; WORLD_ROW];
        tree.world(1, &lift(0.0), &ray, &mut row);
        let low = row;
        assert_eq!(low[0], 1.0);
        tree.world(2, &lift(1.0), &ray, &mut row);
        assert_eq!(row[0], 2.0);
        assert!(row[1] < low[1]);
        let high = row;
        tree.world(3, &lift(0.0), &ray, &mut row);
        assert!(same(&row, &high));
        // An equal distance keeps the earlier mesh, as the scene's pick does.
        tree.world(4, &lift(1.0), &ray, &mut row);
        assert!(same(&row, &high));
    }

    #[test]
    fn root_bounds_reject_rays_that_miss_the_mesh() {
        let (positions, indices) = grid(4);
        let mut tree = Bvh::build(&positions, &indices, MAX_BYTES).unwrap();
        let m = Matrices {
            to_local: IDENTITY,
            to_world: IDENTITY,
            normal: IDENTITY,
        };
        let ray = [0.3, 5.0, 0.2, 0.0, -1.0, 0.0, 100.0, 0.0];
        let mut row = [0.0; WORLD_ROW];
        tree.world(1, &m, &ray, &mut row);
        assert_eq!(row[0], 1.0);
        let far = V3 {
            x: 100.0,
            y: 100.0,
            z: 100.0,
        };
        tree.bounds = Bounds::of_box(far, far);
        let mut row = [0.0; WORLD_ROW];
        tree.world(1, &m, &ray, &mut row);
        assert_eq!(row[0], 0.0);
    }

    #[test]
    fn bounds_follow_babylon() {
        let b = Bounds::of_box(V3 { x: -1.0, y: -2.0, z: -3.0 }, V3 { x: 3.0, y: 2.0, z: 1.0 });
        assert_eq!((b.center.x, b.center.y, b.center.z), (1.0, 0.0, -1.0));
        assert_eq!(b.radius, 48.0_f64.sqrt() * 0.5);
        let o = V3 { x: 10.0, y: 0.0, z: -1.0 };
        assert!(b.sphere(o, V3 { x: -1.0, y: 0.0, z: 0.0 }));
        assert!(!b.sphere(o, V3 { x: 1.0, y: 0.0, z: 0.0 }));
        assert!(b.boxed(o, V3 { x: -1.0, y: 0.0, z: 0.0 }));
        // Direction components under 1e-7 count as parallel.
        assert!(!b.boxed(V3 { x: 0.0, y: 5.0, z: 0.0 }, V3 { x: 0.0, y: 5e-8, z: 1.0 }));
        assert_eq!(js_max(-0.0, 0.0).to_bits(), 0.0_f64.to_bits());
        assert_eq!(js_min(0.0, -0.0).to_bits(), (-0.0_f64).to_bits());
    }
}
