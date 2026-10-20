//! Owned, immutable local-space triangle BVHs for worker-side ground queries.
//!
//! The triangle arithmetic follows Babylon's Ray.intersectsTriangle, including
//! epsilon barycentrics, finite ray length and first-face ties. It does not
//! replace scene eligibility, transforms, world normals or ECEF conversion.
//! No ordinary Rust memory is shared with a concurrent reader. A mesh handle
//! keeps its geometry alive until explicit release in its owning worker.

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
const INVALID: u32 = 1;
const ALLOCATION: u32 = 2;
const GEOMETRY: u32 = 3;
const MESH: u32 = 4;
const RAYS: u32 = 5;

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
struct Bvh {
    /// Triangle corners and original face IDs in leaf order.
    triangles: Vec<[f32; 9]>,
    faces: Vec<u32>,
    nodes: Vec<Node>,
    bytes: usize,
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
        let count = indices.len() / 3;
        let node_total = node_count(count);
        // Reserve everything up front: no implicit Vec growth or partially
        // published tree on allocation failure. Items are released after the
        // build, so only the triangles, faces and nodes stay accounted.
        let bytes = count
            .checked_mul(size_of::<[f32; 9]>() + size_of::<u32>())
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
        let mut triangles = Vec::new();
        triangles.try_reserve_exact(count).map_err(|_| ALLOCATION)?;
        let mut faces = Vec::new();
        faces.try_reserve_exact(count).map_err(|_| ALLOCATION)?;
        let corner = |i: u32| {
            let offset = i as usize * 3;
            [positions[offset], positions[offset + 1], positions[offset + 2]]
        };
        for (face, corners) in indices.chunks_exact(3).enumerate() {
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
            let at = item.face as usize * 3;
            let (a, b, c) = (
                corner(indices[at]),
                corner(indices[at + 1]),
                corner(indices[at + 2]),
            );
            triangles.push([a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]]);
            faces.push(item.face);
        }
        Ok(Self {
            triangles,
            faces,
            nodes,
            bytes,
        })
    }
    fn query(&self, rays: &[f64], output: &mut [f64]) -> Result<(), u32> {
        if rays.is_empty()
            || !rays.len().is_multiple_of(8)
            || rays.len() / 8 > MAX_RAYS
            || output.len() != rays.len()
            || rays.chunks_exact(8).any(|ray| {
                ray.iter().any(|v| !v.is_finite())
                    || ray[3] <= 0.0
                    || ray[7] < 0.0
                    || (ray[4] == 0.0 && ray[5] == 0.0 && ray[6] == 0.0)
            })
        {
            return Err(RAYS);
        }
        for (ray, result) in rays.chunks_exact(8).zip(output.chunks_exact_mut(8)) {
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
            let mut best = ray[3];
            let mut face = u32::MAX;
            let mut bu = 0.0;
            let mut bv = 0.0;
            let mut normal = V3::default();
            let mut stack = [0_usize; 64];
            let mut size = 1;
            while size > 0 {
                size -= 1;
                let node = &self.nodes[stack[size]];
                if !intersects_bounds(node, origin, direction, best, ray[7]) {
                    continue;
                }
                if node.count == 0 {
                    // Median splits on <=262144 triangles fit <20 levels.
                    stack[size] = node.left;
                    stack[size + 1] = node.right;
                    size += 2;
                    continue;
                }
                let range = node.start..node.start + node.count;
                for (triangle, &id) in self.triangles[range.clone()].iter().zip(&self.faces[range])
                {
                    if let Some((distance, a, b, n)) =
                        intersect_triangle(triangle, origin, direction, ray[3], ray[7])
                    {
                        if distance < best || (distance == best && id < face) {
                            best = distance;
                            face = id;
                            bu = a;
                            bv = b;
                            normal = n;
                        }
                    }
                }
            }
            // [hit, local-ray parameter, original face, bu, bv, raw normal xyz].
            // World transform/normalisation remains a host adapter operation.
            result.copy_from_slice(&[
                if face == u32::MAX { 0.0 } else { 1.0 },
                if face == u32::MAX { -1.0 } else { best },
                if face == u32::MAX { -1.0 } else { face as f64 },
                bu,
                bv,
                normal.x,
                normal.y,
                normal.z,
            ]);
        }
        Ok(())
    }
}

fn intersects_bounds(node: &Node, origin: V3, direction: V3, length: f64, epsilon: f64) -> bool {
    let mut near: f64 = 0.0;
    let mut far = length;
    for axis in 0..3 {
        // Triangle epsilon can include points slightly outside a face. The
        // aggregate node width bounds both edge terms; 1mm covers roundoff.
        let padding = 0.001 + 2.0 * epsilon * (node.high.axis(axis) - node.low.axis(axis));
        let low = node.low.axis(axis) - padding;
        let high = node.high.axis(axis) + padding;
        let o = origin.axis(axis);
        let d = direction.axis(axis);
        if !low.is_finite() || !high.is_finite() {
            return true;
        }
        if d == 0.0 {
            if o < low || o > high {
                return false;
            }
            continue;
        }
        let a = (low - o) / d;
        let b = (high - o) / d;
        near = near.max(a.min(b));
        far = far.min(a.max(b));
        if near > far {
            return false;
        }
    }
    true
}

fn intersect_triangle(
    triangle: &[f32; 9],
    origin: V3,
    direction: V3,
    length: f64,
    epsilon: f64,
) -> Option<(f64, f64, f64, V3)> {
    let corner = |at: usize| V3 {
        x: triangle[at] as f64,
        y: triangle[at + 1] as f64,
        z: triangle[at + 2] as f64,
    };
    let (a, b, c) = (corner(0), corner(3), corner(6));
    let edge1 = b.sub(a);
    let edge2 = c.sub(a);
    let pvec = direction.cross(edge2);
    let det = edge1.dot(pvec);
    if det == 0.0 {
        return None;
    }
    let invdet = 1.0 / det;
    let tvec = origin.sub(a);
    let bv = tvec.dot(pvec) * invdet;
    if bv < -epsilon || bv > 1.0 + epsilon {
        return None;
    }
    let qvec = tvec.cross(edge1);
    let bw = direction.dot(qvec) * invdet;
    if bw < -epsilon || bv + bw > 1.0 + epsilon {
        return None;
    }
    let distance = edge2.dot(qvec) * invdet;
    if !distance.is_finite() || distance > length || distance < 0.0 {
        return None;
    }
    Some((distance, 1.0 - bv - bw, bv, edge1.cross(edge2)))
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
    fn buffer(&self, pointer: usize, kind: u32, len: u32) -> Result<&Buffer, u32> {
        self.buffers
            .iter()
            .find(|b| b.pointer() == pointer && b.kind() == kind && b.len() == len as usize)
            .ok_or(INVALID)
    }
    fn build(
        &mut self,
        positions: usize,
        position_len: u32,
        indices: usize,
        index_len: u32,
    ) -> Result<u32, u32> {
        if self.meshes.len() >= MAX_MESHES
            || self.next_mesh == u32::MAX
            || self.meshes.try_reserve(1).is_err()
        {
            return Err(ALLOCATION);
        }
        let Buffer::F32(p) = self.buffer(positions, 1, position_len)? else {
            return Err(INVALID);
        };
        let Buffer::U32(i) = self.buffer(indices, 2, index_len)? else {
            return Err(INVALID);
        };
        let tree = Bvh::build(p, i, MAX_BYTES.saturating_sub(self.bytes))?;
        self.next_mesh += 1;
        let id = self.next_mesh;
        self.bytes += tree.bytes;
        self.meshes.push((id, tree));
        Ok(id)
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
        let tree = &self
            .meshes
            .iter()
            .find(|(id, _)| *id == mesh)
            .ok_or(MESH)?
            .1;
        let rays_index = self
            .buffers
            .iter()
            .position(|b| b.pointer() == rays_ptr && b.kind() == 3 && b.len() == rays_len as usize)
            .ok_or(INVALID)?;
        let output_index = self
            .buffers
            .iter()
            .position(|b| {
                b.pointer() == output_ptr && b.kind() == 3 && b.len() == output_len as usize
            })
            .ok_or(INVALID)?;
        let (rays, output) = if rays_index < output_index {
            let (left, right) = self.buffers.split_at_mut(output_index);
            (&left[rays_index], &mut right[0])
        } else {
            let (left, right) = self.buffers.split_at_mut(rays_index);
            (&right[0], &mut left[output_index])
        };
        let Buffer::F64(rays) = rays else {
            return Err(INVALID);
        };
        let Buffer::F64(output) = output else {
            return Err(INVALID);
        };
        tree.query(rays, output)
    }
}
thread_local! { static REGISTRY: RefCell<Registry> = RefCell::new(Registry::default()); }
fn with<T>(failure: T, run: impl FnOnce(&mut Registry) -> T) -> T {
    REGISTRY.with(|r| match r.try_borrow_mut() {
        Ok(mut r) => run(&mut r),
        Err(_) => failure,
    })
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
        let Some(i) = r
            .buffers
            .iter()
            .position(|b| b.pointer() == pointer && b.kind() == kind && b.len() == len as usize)
        else {
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
        match r.build(positions, position_len, indices, index_len) {
            Ok(id) => {
                r.error = 0;
                id
            }
            Err(e) => {
                r.error = e;
                0
            }
        }
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn ground_release(mesh: u32) -> u32 {
    with(INVALID, |r| {
        let Some(index) = r.meshes.iter().position(|(id, _)| *id == mesh) else {
            return MESH;
        };
        let (_, tree) = r.meshes.swap_remove(index);
        r.bytes -= tree.bytes;
        0
    })
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

/// Immutable traversal data for a synchronous host reader. Geometry remains
/// owned by the host; no WASM pointer escapes this explicit owned copy.
#[unsafe(no_mangle)]
pub extern "C" fn ground_snapshot_len(mesh: u32) -> u32 {
    with(0, |r| {
        let Some((_, tree)) = r.meshes.iter().find(|(id, _)| *id == mesh) else {
            r.error = MESH;
            return 0;
        };
        (2 + tree.nodes.len() * 10 + tree.faces.len()) as u32
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn ground_snapshot(mesh: u32, output: usize, output_len: u32) -> u32 {
    with(INVALID, |r| {
        let Some((_, tree)) = r.meshes.iter().find(|(id, _)| *id == mesh) else {
            return MESH;
        };
        let expected = 2 + tree.nodes.len() * 10 + tree.faces.len();
        let Some(Buffer::F64(values)) = r.buffers.iter_mut().find(|b| {
            b.pointer() == output && b.kind() == 3 && b.len() == output_len as usize
        }) else {
            return INVALID;
        };
        if values.len() != expected {
            return INVALID;
        }
        values[0] = tree.nodes.len() as f64;
        values[1] = tree.faces.len() as f64;
        for (index, node) in tree.nodes.iter().enumerate() {
            values[2 + index * 10..2 + (index + 1) * 10].copy_from_slice(&[
                node.low.x, node.low.y, node.low.z, node.high.x, node.high.y, node.high.z,
                node.left as f64, node.right as f64, node.start as f64, node.count as f64,
            ]);
        }
        let offset = 2 + tree.nodes.len() * 10;
        for (index, face) in tree.faces.iter().enumerate() {
            values[offset + index] = *face as f64;
        }
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
}
