//! Terrain mesh numeric implementation. Compiled; functional parity is unvalidated.
//!
//! Input ABI: seven f64 header words [version,z,x,y,segments,gridCount,
//! neighborsPresent], followed by six words per grid [z,x,y,size,heightPtr,
//! heightElements]. Grid zero is the source; following grids retain neighbor
//! order. Undefined neighbors and an empty neighbor array remain distinct.
//! All pointers must identify exact, live allocations made by this instance.
//! Results use monotonic handles, not caller-provided output pointers.
//! Imports are trusted functions from the executing worker's Math realm.

use std::cell::RefCell;

const ABI: u32 = 1;
const MAX_BYTES: usize = 128 * 1024 * 1024;
const MAX_BUFFER_BYTES: usize = 64 * 1024 * 1024;
// A mesh job takes one height buffer a grid: up to 69 grids (a patch of
// narrow neighbour bands, audit L6), its descriptor and its results.
const MAX_BUFFERS: usize = 160;
const MAX_SEGMENTS: usize = 512;
/// A grid and up to 68 neighbours: 8 whole, or narrow bands (the engine's MAX_TERRAIN_NEIGHBORS).
const MAX_GRIDS: usize = 69;
const MAX_GRID_SIDE: usize = 4096;
type ResultCode<T> = Result<T, u32>;
// 1 descriptor/dimensions, 2 allocation/ownership, 3 budget/allocation failure,
// 4 grid layout, 5 result/slot, 6 busy/reentrant, 7 unsupported native-host realm.

struct Mesh {
    positions: Vec<f64>,
    target: Vec<f32>,
    uvs: Vec<f64>,
    indices: Vec<u32>,
    metadata: Vec<f64>,
}

impl Mesh {
    fn bytes(&self) -> usize {
        (self.positions.len() + self.uvs.len() + self.metadata.len()) * 8
            + (self.target.len() + self.indices.len()) * 4
    }

    fn slot(&self, slot: u32) -> Option<(usize, usize)> {
        match slot {
            0 => Some((self.positions.as_ptr() as usize, self.positions.len())),
            1 => Some((self.target.as_ptr() as usize, self.target.len())),
            2 if !self.uvs.is_empty() => Some((self.uvs.as_ptr() as usize, self.uvs.len())),
            2 => Some((0, 0)),
            3 => Some((self.indices.as_ptr() as usize, self.indices.len())),
            4 => Some((self.metadata.as_ptr() as usize, self.metadata.len())),
            _ => None,
        }
    }
}

struct Registry {
    f64s: Vec<Vec<f64>>,
    f32s: Vec<Vec<f32>>,
    meshes: Vec<(u32, Mesh)>,
    bytes: usize,
    next_handle: u32,
}

impl Default for Registry {
    fn default() -> Self {
        Self {
            f64s: Vec::new(),
            f32s: Vec::new(),
            meshes: Vec::new(),
            bytes: 0,
            next_handle: 1,
        }
    }
}

fn zeroed<T: Default + Clone>(len: usize) -> ResultCode<Vec<T>> {
    let mut values = Vec::new();
    values.try_reserve_exact(len).map_err(|_| 3_u32)?;
    values.resize(len, T::default());
    Ok(values)
}

impl Registry {
    fn budget(&self, bytes: usize, buffers: usize) -> bool {
        self.bytes
            .checked_add(bytes)
            .is_some_and(|total| total <= MAX_BYTES)
            && self.f64s.len() + self.f32s.len() + self.meshes.len() * 5 + buffers <= MAX_BUFFERS
    }

    fn allocate(&mut self, kind: u32, len: u32) -> ResultCode<usize> {
        let size = if kind == 0 {
            8
        } else if kind == 1 {
            4
        } else {
            return Err(2);
        };
        let bytes = (len as usize).checked_mul(size).ok_or(3_u32)?;
        if bytes == 0 || bytes > MAX_BUFFER_BYTES || !self.budget(bytes, 1) {
            return Err(3);
        }
        let pointer = if kind == 0 {
            self.f64s.try_reserve(1).map_err(|_| 3_u32)?;
            let data = zeroed::<f64>(len as usize)?;
            let pointer = data.as_ptr() as usize;
            self.f64s.push(data);
            pointer
        } else {
            self.f32s.try_reserve(1).map_err(|_| 3_u32)?;
            let data = zeroed::<f32>(len as usize)?;
            let pointer = data.as_ptr() as usize;
            self.f32s.push(data);
            pointer
        };
        self.bytes += bytes;
        Ok(pointer)
    }

    fn free(&mut self, kind: u32, pointer: usize, len: u32) -> ResultCode<()> {
        if kind == 0 {
            let index = self
                .f64s
                .iter()
                .position(|data| data.as_ptr() as usize == pointer && data.len() == len as usize)
                .ok_or(2_u32)?;
            let data = self.f64s.swap_remove(index);
            self.bytes -= data.len() * 8;
        } else if kind == 1 {
            let index = self
                .f32s
                .iter()
                .position(|data| data.as_ptr() as usize == pointer && data.len() == len as usize)
                .ok_or(2_u32)?;
            let data = self.f32s.swap_remove(index);
            self.bytes -= data.len() * 4;
        } else {
            return Err(2);
        }
        Ok(())
    }
}

struct State {
    registry: Option<Registry>,
    error: u32,
}
thread_local! {
    static STATE: RefCell<State> = RefCell::new(State { registry: Some(Registry::default()), error: 0 });
}

fn operate<T: Copy>(failure: T, action: impl FnOnce(&mut Registry) -> ResultCode<T>) -> T {
    STATE.with(|state| {
        let Ok(mut state) = state.try_borrow_mut() else {
            return failure;
        };
        let Some(registry) = state.registry.as_mut() else {
            state.error = 6;
            return failure;
        };
        match action(registry) {
            Ok(value) => {
                state.error = 0;
                value
            }
            Err(error) => {
                state.error = error;
                failure
            }
        }
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn terrain_abi_version() -> u32 {
    ABI
}

#[unsafe(no_mangle)]
pub extern "C" fn terrain_last_error() -> u32 {
    STATE.with(|state| state.try_borrow().map_or(6, |state| state.error))
}

/// kind 0: Float64 descriptor, kind 1: Float32 heights. len counts elements.
#[unsafe(no_mangle)]
pub extern "C" fn terrain_alloc(kind: u32, len: u32) -> usize {
    operate(0, |registry| registry.allocate(kind, len))
}

#[unsafe(no_mangle)]
pub extern "C" fn terrain_free(kind: u32, pointer: usize, len: u32) -> u32 {
    operate(2, |registry| registry.free(kind, pointer, len).map(|()| 0))
}

#[unsafe(no_mangle)]
pub extern "C" fn terrain_result_ptr(handle: u32, slot: u32) -> usize {
    operate(0, |registry| {
        registry
            .meshes
            .iter()
            .find(|(id, _)| *id == handle)
            .and_then(|(_, mesh)| mesh.slot(slot))
            .map(|(pointer, _)| pointer)
            .ok_or(5)
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn terrain_result_len(handle: u32, slot: u32) -> u32 {
    operate(0, |registry| {
        registry
            .meshes
            .iter()
            .find(|(id, _)| *id == handle)
            .and_then(|(_, mesh)| mesh.slot(slot))
            .map(|(_, len)| len as u32)
            .ok_or(5)
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn terrain_release_result(handle: u32) -> u32 {
    operate(5, |registry| {
        let index = registry
            .meshes
            .iter()
            .position(|(id, _)| *id == handle)
            .ok_or(5_u32)?;
        let (_, mesh) = registry.meshes.swap_remove(index);
        registry.bytes -= mesh.bytes();
        Ok(0)
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn terrain_build(descriptor: usize, len: u32, with_uvs: u32) -> u32 {
    #[cfg(not(target_arch = "wasm32"))]
    {
        let _ = (descriptor, len, with_uvs);
        STATE.with(|state| state.borrow_mut().error = 7);
        0
    }
    #[cfg(target_arch = "wasm32")]
    {
        // Move registry ownership out before imported Math calls. There is no
        // RefCell borrow over a JS callback; reentry sees None and fails busy.
        let taken = STATE.with(|state| {
            let Ok(mut state) = state.try_borrow_mut() else {
                return None;
            };
            let registry = state.registry.take();
            if registry.is_none() {
                state.error = 6;
            }
            registry
        });
        let Some(mut registry) = taken else {
            return 0;
        };
        let result = kernel::build(&mut registry, descriptor, len, with_uvs);
        STATE.with(|state| {
            let mut state = state.borrow_mut();
            state.registry = Some(registry);
            match result {
                Ok(handle) => {
                    state.error = 0;
                    handle
                }
                Err(error) => {
                    state.error = error;
                    0
                }
            }
        })
    }
}

/// Retained descriptors/heights and per-job coordinate/output allocations are
/// all instance-owned. As with mesh building, imported Math cannot reenter.
#[unsafe(no_mangle)]
pub extern "C" fn terrain_sample_batch(descriptor: usize, descriptor_len: u32, packed: usize,
    packed_len: u32, coordinates: usize, coordinate_len: u32, output: usize, output_len: u32) -> u32 {
    #[cfg(not(target_arch = "wasm32"))]
    { let _ = (descriptor, descriptor_len, packed, packed_len, coordinates, coordinate_len, output, output_len); 7 }
    #[cfg(target_arch = "wasm32")]
    {
        let taken = STATE.with(|state| state.try_borrow_mut().ok().and_then(|mut state| state.registry.take()));
        let Some(mut registry) = taken else { return 6; };
        let result = kernel::sample_batch(&mut registry, descriptor, descriptor_len, packed, packed_len,
            coordinates, coordinate_len, output, output_len);
        STATE.with(|state| {
            let mut state = state.borrow_mut(); state.registry = Some(registry);
            match result { Ok(status) => { state.error = 0; status }, Err(error) => { state.error = error; error } }
        })
    }
}

#[cfg(target_arch = "wasm32")]
mod kernel {
    use super::*;

    #[link(wasm_import_module = "Math")]
    unsafe extern "C" {
        fn sin(value: f64) -> f64;
        fn cos(value: f64) -> f64;
        fn atan(value: f64) -> f64;
        fn sinh(value: f64) -> f64;
        fn pow(base: f64, exponent: f64) -> f64;
    }
    // These imports must be trusted, non-throwing executing-realm Math builtins.
    fn js_sin(x: f64) -> f64 {
        unsafe { sin(x) }
    }
    fn js_cos(x: f64) -> f64 {
        unsafe { cos(x) }
    }
    fn js_atan(x: f64) -> f64 {
        unsafe { atan(x) }
    }
    fn js_sinh(x: f64) -> f64 {
        unsafe { sinh(x) }
    }
    fn js_pow(x: f64, y: f64) -> f64 {
        unsafe { pow(x, y) }
    }
    // These give Math's results bit for bit without calling out of WebAssembly, as calls to
    // JavaScript cost more than the work. sqrt and floor are IEEE 754's operations in both.
    fn js_sqrt(x: f64) -> f64 {
        x.sqrt()
    }
    fn js_floor(x: f64) -> f64 {
        x.floor()
    }
    /// Math.round: halves toward +inf, -0 from -0.5 to -0, large and non-finite values unchanged.
    /// Not f64::round, which takes halves away from zero.
    fn js_round(x: f64) -> f64 {
        let c = x.ceil();
        if c - 0.5 > x { c - 1.0 } else { c }
    }
    /// Math.min of two: NaN if either is, and -0 below +0. Not f64::min, which returns the
    /// other argument for NaN and either zero.
    fn js_min(x: f64, y: f64) -> f64 {
        if x < y { x } else if y < x { y } else if x == y { f64::from_bits(x.to_bits() | y.to_bits()) } else { f64::NAN }
    }
    /// Math.max of two: NaN if either is, and +0 above -0.
    fn js_max(x: f64, y: f64) -> f64 {
        if x > y { x } else if y > x { y } else if x == y { f64::from_bits(x.to_bits() & y.to_bits()) } else { f64::NAN }
    }
    const PI: f64 = std::f64::consts::PI;
    const DEG_TO_RAD: f64 = PI / 180.0;
    const A: f64 = 6_378_137.0;
    const F: f64 = 1.0 / 298.257223563;
    const E2: f64 = 2.0 * F - F * F;

    #[derive(Clone, Copy)]
    struct Tile {
        z: f64,
        x: f64,
        y: f64,
    }
    struct Grid<'a> {
        tile: Tile,
        /// The executing realm's 2^(this zoom - source zoom), constant for a job.
        source_scale: f64,
        size: usize,
        heights: &'a [f32],
        sparse: bool,
        missing: std::cell::Cell<bool>,
    }
    impl Grid<'_> {
        // Each bilinear row reads a pixel and its immediate right neighbour,
        // or the same clamped pixel twice. Sorted sparse keys need one search.
        fn row_values(&self, index: usize, next: usize) -> [f32; 2] {
            if !self.sparse { return [self.heights[index], self.heights[next]]; }
            let mut low = 0;
            let mut high = self.heights.len() / 2;
            while low < high {
                let middle = (low + high) / 2;
                if self.heights[middle * 2] < index as f32 { low = middle + 1; }
                else { high = middle; }
            }
            let found = low * 2 < self.heights.len() && self.heights[low * 2] == index as f32;
            let a = if found { self.heights[low * 2 + 1] }
                else { self.missing.set(true); f32::NAN };
            // If the first is absent, its lower bound is also the only place
            // the immediately following key could be. Neither read may hide
            // an absent pixel, even if interpolation gives it zero weight.
            let at = low + usize::from(found && next != index);
            let b = if at * 2 < self.heights.len() && self.heights[at * 2] == next as f32 {
                self.heights[at * 2 + 1]
            } else { self.missing.set(true); f32::NAN };
            [a, b]
        }
    }
    struct Parallel {
        sin_lat: f64,
        cos_lat: f64,
        n: f64,
        polar_n: f64,
    }

    fn integer(value: f64, maximum: usize) -> ResultCode<usize> {
        if !value.is_finite()
            || value < 0.0
            || value > maximum as f64
            || value != value as usize as f64
        {
            return Err(1);
        }
        Ok(value as usize)
    }

    fn tile(z: f64, x: f64, y: f64) -> ResultCode<Tile> {
        integer(z, 30)?;
        let side = js_pow(2.0, z);
        integer(x, side as usize - 1)?;
        integer(y, side as usize - 1)?;
        Ok(Tile { z, x, y })
    }

    fn lon(x: f64, z: f64) -> f64 {
        (x / js_pow(2.0, z)) * 360.0 - 180.0
    }
    fn lat(y: f64, z: f64) -> f64 {
        let n = PI - (2.0 * PI * y) / js_pow(2.0, z);
        js_atan(js_sinh(n)) / DEG_TO_RAD
    }
    fn parallel(latitude: f64) -> Parallel {
        let sin_lat = js_sin(latitude);
        let n = A / js_sqrt(1.0 - E2 * sin_lat * sin_lat);
        Parallel {
            sin_lat,
            cos_lat: js_cos(latitude),
            n,
            polar_n: n * (1.0 - E2),
        }
    }
    fn center(tile: Tile) -> [f64; 3] {
        let latitude = lat(tile.y + 0.5, tile.z) * DEG_TO_RAD;
        let longitude = lon(tile.x + 0.5, tile.z) * DEG_TO_RAD;
        let sin_lat = js_sin(latitude);
        let cos_lat = js_cos(latitude);
        let sin_lon = js_sin(longitude);
        let cos_lon = js_cos(longitude);
        let n = A / js_sqrt(1.0 - E2 * sin_lat * sin_lat);
        [
            (n + 0.0) * cos_lat * cos_lon,
            (n + 0.0) * cos_lat * sin_lon,
            (n * (1.0 - E2) + 0.0) * sin_lat,
        ]
    }
    fn own(grid: &Grid<'_>, x: f64, y: f64) -> f64 {
        let size = grid.size as f64;
        let px = js_max(0.0, js_min(size - 1.0, (x - grid.tile.x) * size - 0.5));
        let py = js_max(0.0, js_min(size - 1.0, (y - grid.tile.y) * size - 0.5));
        let ix = js_floor(px);
        let iy = js_floor(py);
        let jx = js_min(ix + 1.0, size - 1.0);
        let jy = js_min(iy + 1.0, size - 1.0);
        let u = px - ix;
        let v = py - iy;
        let top = grid.row_values(iy as usize * grid.size + ix as usize, iy as usize * grid.size + jx as usize);
        let bottom = grid.row_values(jy as usize * grid.size + ix as usize, jy as usize * grid.size + jx as usize);
        let a = f64::from(top[0]) * (1.0 - u) + f64::from(top[1]) * u;
        let b = f64::from(bottom[0]) * (1.0 - u) + f64::from(bottom[1]) * u;
        a * (1.0 - v) + b * v
    }
    fn covers(candidate: &Grid<'_>, tx: f64, ty: f64) -> bool {
        let scale = candidate.source_scale;
        js_floor(tx * scale) == candidate.tile.x && js_floor(ty * scale) == candidate.tile.y
    }
    /// The neighbours that covered the last pixels, latest first, tried
    /// before the ordered scan when no two neighbours share any place: then
    /// the first that covers a pixel is the only one. A patch of bands has up
    /// to 68 grids, and a mesh's edges read a few of them in turn (audit L6;
    /// sampleTerrainGrid's lookup in TypeScript).
    struct Lookup {
        disjoint: bool,
        recent: [usize; RECENT_NEIGHBORS],
        len: usize,
        world_size: f64,
    }
    const RECENT_NEIGHBORS: usize = 4;
    /// Whether one tile is the other or within it. Tile coordinates are
    /// integers below 2^30, so the shift is exact.
    fn overlaps(a: &Tile, b: &Tile) -> bool {
        let (outer, inner) = if a.z <= b.z { (a, b) } else { (b, a) };
        let shift = (inner.z - outer.z) as u32;
        ((inner.x as u64) >> shift) == outer.x as u64
            && ((inner.y as u64) >> shift) == outer.y as u64
    }
    fn lookup(grid: Option<&Grid<'_>>, neighbors: &[Grid<'_>]) -> Lookup {
        let mut disjoint = true;
        'pairs: for (i, a) in neighbors.iter().enumerate() {
            for b in &neighbors[i + 1..] {
                if overlaps(&a.tile, &b.tile) {
                    disjoint = false;
                    break 'pairs;
                }
            }
        }
        Lookup { disjoint, recent: [0; RECENT_NEIGHBORS], len: 0,
            world_size: grid.map_or(1.0, |grid| js_pow(2.0, grid.tile.z)) }
    }
    fn pixel(
        grid: &Grid<'_>,
        neighbors: &[Grid<'_>],
        lookup: &mut Lookup,
        col: f64,
        row: f64,
    ) -> f64 {
        let n = lookup.world_size;
        let tx = ((grid.tile.x + (col + 0.5) / grid.size as f64) % n + n) % n;
        let ty = js_max(
            0.0,
            js_min(n - 1e-9, grid.tile.y + (row + 0.5) / grid.size as f64),
        );
        let mut source = grid;
        if !covers(grid, tx, ty) {
            let mut found = None;
            if lookup.disjoint {
                for &index in &lookup.recent[..lookup.len] {
                    if covers(&neighbors[index], tx, ty) {
                        found = Some(index);
                        break;
                    }
                }
            }
            if found.is_none() {
                for (index, neighbor) in neighbors.iter().enumerate() {
                    if covers(neighbor, tx, ty) {
                        found = Some(index);
                        break;
                    }
                }
                if let (Some(index), true) = (found, lookup.disjoint) {
                    let len = (lookup.len + 1).min(RECENT_NEIGHBORS);
                    for k in (1..len).rev() {
                        lookup.recent[k] = lookup.recent[k - 1];
                    }
                    lookup.recent[0] = index;
                    lookup.len = len;
                }
            }
            if let Some(index) = found {
                source = &neighbors[index];
            }
        }
        let scale = source.source_scale;
        own(source, tx * scale, ty * scale)
    }
    fn height(
        grid: &Grid<'_>,
        neighbors: &[Grid<'_>],
        lookup: &mut Lookup,
        neighbors_present: bool,
        x: f64,
        y: f64,
    ) -> f64 {
        let size = grid.size as f64;
        if neighbors_present
            && (x - grid.tile.x < 0.5 / size
                || x - grid.tile.x > 1.0 - 0.5 / size
                || y - grid.tile.y < 0.5 / size
                || y - grid.tile.y > 1.0 - 0.5 / size)
        {
            let px = (x - grid.tile.x) * size - 0.5;
            let py = (y - grid.tile.y) * size - 0.5;
            let ix = js_floor(px);
            let iy = js_floor(py);
            let u = px - ix;
            let v = py - iy;
            return (pixel(grid, neighbors, lookup, ix, iy) * (1.0 - u)
                + pixel(grid, neighbors, lookup, ix + 1.0, iy) * u)
                * (1.0 - v)
                + (pixel(grid, neighbors, lookup, ix, iy + 1.0) * (1.0 - u)
                    + pixel(grid, neighbors, lookup, ix + 1.0, iy + 1.0) * u)
                    * v;
        }
        own(grid, x, y)
    }

    /// Batched interpolation of an immutable packed grid snapshot. Coordinates
    /// are f64 fractional tile coordinates at the source grid's zoom. Preserve
    /// sampleTerrainGrid's f64 result; narrowing to f32 changes imagery slopes.
    pub(super) fn sample_batch(registry: &mut Registry, descriptor: usize, descriptor_len: u32,
        packed: usize, packed_len: u32, coordinates: usize, coordinate_len: u32,
        output: usize, output_len: u32) -> ResultCode<u32> {
        if coordinate_len == 0 || coordinate_len % 2 != 0 || coordinate_len > 131_072
            || output_len != coordinate_len / 2 || output == descriptor || output == coordinates {
            return Err(1);
        }
        let words = registry.f64s.iter().find(|v| v.as_ptr() as usize == descriptor && v.len() == descriptor_len as usize).ok_or(2_u32)?;
        let xy = registry.f64s.iter().find(|v| v.as_ptr() as usize == coordinates && v.len() == coordinate_len as usize).ok_or(2_u32)?;
        let heights = registry.f32s.iter().find(|v| v.as_ptr() as usize == packed && v.len() == packed_len as usize).ok_or(2_u32)?;
        if words.len() < 3 || (words[0] != 1.0 && words[0] != 2.0) || !xy.iter().all(|v| v.is_finite()) { return Err(1); }
        let sparse = words[0] == 2.0;
        let count = integer(words[1], MAX_GRIDS)?;
        let neighbors_present = match words[2] { 0.0 => false, 1.0 => true, _ => return Err(1) };
        if count == 0 || words.len() != 3 + count * 6 || (count > 1 && !neighbors_present) { return Err(1); }
        let output_index = registry.f64s.iter().position(|v| v.as_ptr() as usize == output && v.len() == output_len as usize).ok_or(2_u32)?;
        let mut grids = Vec::new();
        grids.try_reserve_exact(count).map_err(|_| 3_u32)?;
        for i in 0..count {
            let at = 3 + i * 6;
            let grid_tile = tile(words[at], words[at + 1], words[at + 2])?;
            let size = integer(words[at + 3], MAX_GRID_SIDE)?;
            let offset = integer(words[at + 4], heights.len())?;
            let length = integer(words[at + 5], heights.len())?;
            if size == 0 || (!sparse && length != size * size) || (sparse && length % 2 != 0)
                || offset.checked_add(length).is_none_or(|end| end > heights.len()) { return Err(4); }
            let values = &heights[offset..offset + length];
            if sparse {
                let mut previous = None;
                for pair in values.chunks_exact(2) {
                    let index = integer(f64::from(pair[0]), size * size - 1)?;
                    if previous.is_some_and(|value| index <= value) { return Err(4); }
                    previous = Some(index);
                }
            }
            grids.push(Grid { tile: grid_tile, source_scale: js_pow(2.0, grid_tile.z - words[3]),
                size, heights: values, sparse, missing: std::cell::Cell::new(false) });
        }
        // Keep ownership checks in the registry and never form caller slices.
        if !registry.budget(output_len as usize * 8, 0) { return Err(3); }
        let mut result = zeroed::<f64>(output_len as usize)?;
        let mut neighbor_lookup = lookup(grids.first(), &grids[1..]);
        for (at, value) in result.iter_mut().enumerate() {
            *value = height(&grids[0], &grids[1..], &mut neighbor_lookup, neighbors_present, xy[at * 2], xy[at * 2 + 1]);
        }
        if grids.iter().any(|grid| grid.missing.get()) { return Err(4); }
        registry.f64s[output_index].copy_from_slice(&result);
        Ok(0)
    }

    pub(super) fn build(
        registry: &mut Registry,
        descriptor: usize,
        len: u32,
        with_uvs: u32,
    ) -> ResultCode<u32> {
        if with_uvs > 1 {
            return Err(1);
        }
        let input = registry
            .f64s
            .iter()
            .find(|data| data.as_ptr() as usize == descriptor && data.len() == len as usize)
            .ok_or(2_u32)?;
        if input.len() < 7 || input[0] != ABI as f64 {
            return Err(1);
        }
        let target = tile(input[1], input[2], input[3])?;
        let segment_count = js_max(1.0, js_round(input[4]));
        let segments = integer(segment_count, MAX_SEGMENTS)?;
        if segments == 0 {
            return Err(1);
        }
        let grid_count = integer(input[5], MAX_GRIDS)?;
        let neighbors_present = match input[6] {
            0.0 => false,
            1.0 => true,
            _ => return Err(1),
        };
        if input.len() != 7 + grid_count * 6
            || (grid_count == 0 && neighbors_present)
            || (grid_count > 1 && !neighbors_present)
        {
            return Err(1);
        }
        let mut grids = Vec::new();
        grids.try_reserve_exact(grid_count).map_err(|_| 3_u32)?;
        for i in 0..grid_count {
            let offset = 7 + i * 6;
            let grid_tile = tile(input[offset], input[offset + 1], input[offset + 2])?;
            let size = integer(input[offset + 3], MAX_GRID_SIDE)?;
            if size == 0 {
                return Err(4);
            }
            let pointer = integer(input[offset + 4], u32::MAX as usize)?;
            let elements = integer(input[offset + 5], MAX_GRID_SIDE * MAX_GRID_SIDE)?;
            if elements != size * size {
                return Err(4);
            }
            let heights = registry
                .f32s
                .iter()
                .find(|data| data.as_ptr() as usize == pointer && data.len() == elements)
                .ok_or(2_u32)?;
            grids.push(Grid {
                tile: grid_tile,
                source_scale: js_pow(2.0, grid_tile.z - input[7]),
                size,
                heights,
                sparse: false,
                missing: std::cell::Cell::new(false),
            });
        }
        let stride = segments + 1;
        let vertices = stride * stride;
        let positions_len = vertices * 3;
        let uv_len = if with_uvs == 1 { vertices * 2 } else { 0 };
        let index_len = segments * segments * 6;
        let output_bytes =
            positions_len * 8 + positions_len * 4 + uv_len * 8 + index_len * 4 + 7 * 8;
        if !registry.budget(output_bytes, 5) || registry.next_handle == u32::MAX {
            return Err(3);
        }
        let mut positions = zeroed::<f64>(positions_len)?;
        let mut target_positions = zeroed::<f32>(positions_len)?;
        let mut uvs = zeroed::<f64>(uv_len)?;
        let mut indices = zeroed::<u32>(index_len)?;
        let origin = center(target);
        let mut sin_lons = zeroed::<f64>(stride)?;
        let mut cos_lons = zeroed::<f64>(stride)?;
        for col in 0..stride {
            let longitude = lon(target.x + col as f64 / segments as f64, target.z);
            sin_lons[col] = js_sin(longitude * DEG_TO_RAD);
            cos_lons[col] = js_cos(longitude * DEG_TO_RAD);
        }
        let scale = grids
            .first()
            .map_or(1.0, |grid| js_pow(2.0, grid.tile.z - target.z));
        let mut min_height = f64::INFINITY;
        let mut max_height = f64::NEG_INFINITY;
        let mut neighbor_lookup = lookup(grids.first(), grids.get(1..).unwrap_or(&[]));
        for row in 0..stride {
            let v = row as f64 / segments as f64;
            let mercator_y = target.y + v;
            let latitude = lat(mercator_y, target.z);
            let parallel = parallel(latitude * DEG_TO_RAD);
            for col in 0..stride {
                let u = col as f64 / segments as f64;
                let altitude = match grids.first() {
                    Some(grid) => height(
                        grid,
                        &grids[1..],
                        &mut neighbor_lookup,
                        neighbors_present,
                        (target.x + u) * scale,
                        mercator_y * scale,
                    ),
                    None => 0.0,
                };
                if altitude < min_height {
                    min_height = altitude;
                }
                if altitude > max_height {
                    max_height = altitude;
                }
                let ecef = [
                    (parallel.n + altitude) * parallel.cos_lat * cos_lons[col],
                    (parallel.n + altitude) * parallel.cos_lat * sin_lons[col],
                    (parallel.polar_n + altitude) * parallel.sin_lat,
                ];
                let vertex = row * stride + col;
                for axis in 0..3 {
                    let relative = ecef[axis] - origin[axis];
                    positions[vertex * 3 + axis] = relative;
                    target_positions[vertex * 3 + axis] = relative as f32;
                }
                if with_uvs == 1 {
                    uvs[vertex * 2] = u;
                    uvs[vertex * 2 + 1] = v;
                }
            }
        }
        let mut index = 0;
        for row in 0..segments {
            for col in 0..segments {
                let a = (row * stride + col) as u32;
                let b = a + 1;
                let c = a + stride as u32;
                let d = c + 1;
                indices[index..index + 6].copy_from_slice(&[a, c, b, b, c, d]);
                index += 6;
            }
        }
        let mut metadata = zeroed::<f64>(7)?;
        metadata.copy_from_slice(&[
            origin[0],
            origin[1],
            origin[2],
            min_height,
            max_height,
            segments as f64,
            grids.first().map_or(-1.0, |grid| grid.tile.z),
        ]);
        let mesh = Mesh {
            positions,
            target: target_positions,
            uvs,
            indices,
            metadata,
        };
        registry.meshes.try_reserve(1).map_err(|_| 3_u32)?;
        let handle = registry.next_handle;
        registry.next_handle += 1;
        registry.bytes += mesh.bytes();
        registry.meshes.push((handle, mesh));
        Ok(handle)
    }
}
