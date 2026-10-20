//! First raster kernel: opaque Terrarium RGBA bytes to Float32 heights.
//!
//! This single-threaded ABI owns every allocation in an instance-local registry.
//! Pointer arguments are identifiers for those live allocations, never arbitrary
//! memory addresses to dereference. Free requires the matching kind and length.
//! Calls do not retain borrows across the JavaScript boundary. Callers must not
//! retain views after freeing, and must refresh views after WASM memory grows.
//! Threaded/shared-memory use needs a separate ownership protocol and is not
//! implemented by this ABI.

use std::cell::RefCell;
use std::mem::size_of;

pub const ABI_VERSION: u32 = 1;
/// ABI safety ceiling. The app's source-image policy remains at 1024 pixels.
pub const MAX_SIDE: u32 = 4096;
pub const MAX_PIXELS: usize = MAX_SIDE as usize * MAX_SIDE as usize;
pub const MAX_BUFFER_BYTES: usize = MAX_PIXELS * size_of::<f32>();
pub const MAX_LIVE_BYTES: usize = 128 * 1024 * 1024;
pub const MAX_LIVE_BUFFERS: usize = 64;

/// Stable ABI statuses. Allocation failure is the null pointer instead.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u32)]
pub enum DecodeError {
    Dimensions = 1,
    RgbaLength = 2,
    OutputLength = 3,
    MissingSamples = 4,
    InvalidAllocation = 5,
}

fn dimensions(width: u32, height: u32) -> Result<usize, DecodeError> {
    if width == 0 || width != height || width > MAX_SIDE {
        return Err(DecodeError::Dimensions);
    }
    Ok(width as usize * height as usize)
}

fn validate_lengths(
    rgba_len: usize,
    width: u32,
    height: u32,
    out_len: usize,
) -> Result<(), DecodeError> {
    let pixels = dimensions(width, height)?;
    if rgba_len != pixels * 4 {
        return Err(DecodeError::RgbaLength);
    }
    if out_len != pixels {
        return Err(DecodeError::OutputLength);
    }
    Ok(())
}

/// Same float32 bits as engine's `decodeTerrarium` byte formula.
///
/// `(red*65536 + green*256 + blue - 8388608)/256` is exact in f64;
/// its result is rounded to f32 only at the output store. Alpha must be 255.
/// Dimensions and lengths are checked before alpha. Errors leave output intact.
pub fn decode_rgba(
    rgba: &[u8],
    width: u32,
    height: u32,
    out: &mut [f32],
) -> Result<(), DecodeError> {
    validate_lengths(rgba.len(), width, height, out.len())?;
    let pixels = rgba.as_chunks::<4>().0;
    if pixels.iter().any(|pixel| pixel[3] != 255) {
        return Err(DecodeError::MissingSamples);
    }
    for (pixel, height) in pixels.iter().zip(out.iter_mut()) {
        let encoded =
            (i32::from(pixel[0]) << 16) | (i32::from(pixel[1]) << 8) | i32::from(pixel[2]);
        *height = (f64::from(encoded - 8_388_608) / 256.0) as f32;
    }
    Ok(())
}

#[derive(Default)]
struct Registry {
    rgba: Vec<Vec<u8>>,
    heights: Vec<Vec<f32>>,
    live_bytes: usize,
}

impl Registry {
    fn can_allocate(&self, bytes: usize) -> bool {
        bytes > 0
            && bytes <= MAX_BUFFER_BYTES
            && self.rgba.len() + self.heights.len() < MAX_LIVE_BUFFERS
            && self
                .live_bytes
                .checked_add(bytes)
                .is_some_and(|total| total <= MAX_LIVE_BYTES)
    }

    fn alloc_rgba(&mut self, len: u32) -> usize {
        let len = len as usize;
        if !self.can_allocate(len) || self.rgba.try_reserve(1).is_err() {
            return 0;
        }
        let mut bytes = Vec::new();
        if bytes.try_reserve_exact(len).is_err() {
            return 0;
        }
        bytes.resize(len, 0);
        let pointer = bytes.as_ptr() as usize;
        self.rgba.push(bytes);
        self.live_bytes += len;
        pointer
    }

    fn alloc_heights(&mut self, len: u32) -> usize {
        let len = len as usize;
        let Some(bytes) = len.checked_mul(size_of::<f32>()) else {
            return 0;
        };
        if !self.can_allocate(bytes) || self.heights.try_reserve(1).is_err() {
            return 0;
        }
        let mut values = Vec::new();
        if values.try_reserve_exact(len).is_err() {
            return 0;
        }
        values.resize(len, 0.0);
        let pointer = values.as_ptr() as usize;
        self.heights.push(values);
        self.live_bytes += bytes;
        pointer
    }

    fn free_rgba(&mut self, pointer: usize, len: u32) -> Result<(), DecodeError> {
        let Some(index) = self
            .rgba
            .iter()
            .position(|bytes| bytes.as_ptr() as usize == pointer && bytes.len() == len as usize)
        else {
            return Err(DecodeError::InvalidAllocation);
        };
        let bytes = self.rgba.swap_remove(index);
        self.live_bytes -= bytes.len();
        Ok(())
    }

    fn free_heights(&mut self, pointer: usize, len: u32) -> Result<(), DecodeError> {
        let Some(index) = self
            .heights
            .iter()
            .position(|values| values.as_ptr() as usize == pointer && values.len() == len as usize)
        else {
            return Err(DecodeError::InvalidAllocation);
        };
        let values = self.heights.swap_remove(index);
        self.live_bytes -= values.len() * size_of::<f32>();
        Ok(())
    }

    fn decode(
        &mut self,
        rgba_ptr: usize,
        rgba_len: u32,
        width: u32,
        height: u32,
        out_ptr: usize,
        out_len: u32,
    ) -> Result<(), DecodeError> {
        validate_lengths(rgba_len as usize, width, height, out_len as usize)?;
        let rgba = self
            .rgba
            .iter()
            .find(|bytes| bytes.as_ptr() as usize == rgba_ptr && bytes.len() == rgba_len as usize)
            .ok_or(DecodeError::InvalidAllocation)?;
        let out = self
            .heights
            .iter_mut()
            .find(|values| values.as_ptr() as usize == out_ptr && values.len() == out_len as usize)
            .ok_or(DecodeError::InvalidAllocation)?;
        decode_rgba(rgba, width, height, out)
    }
}

thread_local! {
    static REGISTRY: RefCell<Registry> = RefCell::new(Registry::default());
}

fn status(result: Result<(), DecodeError>) -> u32 {
    result.map_or_else(|error| error as u32, |()| 0)
}

fn with_registry<T>(failure: T, run: impl FnOnce(&mut Registry) -> T) -> T {
    REGISTRY.with(|registry| match registry.try_borrow_mut() {
        Ok(mut registry) => run(&mut registry),
        Err(_) => failure,
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn raster_abi_version() -> u32 {
    ABI_VERSION
}

/// Allocates zeroed RGBA byte storage. Returns 0 on invalid length or exhaustion.
#[unsafe(no_mangle)]
pub extern "C" fn raster_alloc_rgba(len: u32) -> usize {
    with_registry(0, |registry| registry.alloc_rgba(len))
}

#[unsafe(no_mangle)]
pub extern "C" fn raster_free_rgba(pointer: usize, len: u32) -> u32 {
    with_registry(DecodeError::InvalidAllocation as u32, |registry| {
        status(registry.free_rgba(pointer, len))
    })
}

/// Allocates zeroed float32 output storage; len counts heights, not bytes.
#[unsafe(no_mangle)]
pub extern "C" fn raster_alloc_heights(len: u32) -> usize {
    with_registry(0, |registry| registry.alloc_heights(len))
}

#[unsafe(no_mangle)]
pub extern "C" fn raster_free_heights(pointer: usize, len: u32) -> u32 {
    with_registry(DecodeError::InvalidAllocation as u32, |registry| {
        status(registry.free_heights(pointer, len))
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn raster_decode(
    rgba_ptr: usize,
    rgba_len: u32,
    width: u32,
    height: u32,
    out_ptr: usize,
    out_len: u32,
) -> u32 {
    with_registry(DecodeError::InvalidAllocation as u32, |registry| {
        status(registry.decode(rgba_ptr, rgba_len, width, height, out_ptr, out_len))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reference(pixel: &[u8]) -> f32 {
        (f64::from(pixel[0]) * 256.0 + f64::from(pixel[1]) + f64::from(pixel[2]) / 256.0 - 32768.0)
            as f32
    }

    #[test]
    fn exact_known_height_bits_and_positive_zero() {
        for (pixel, expected) in [
            ([0, 0, 0, 255], -32768.0_f32),
            ([127, 255, 128, 255], -0.5),
            ([128, 0, 0, 255], 0.0),
            ([129, 0, 64, 255], 256.25),
            ([255, 255, 255, 255], f32::from_bits(0x46ff_fffe)),
        ] {
            let mut output = [f32::NAN];
            assert_eq!(decode_rgba(&pixel, 1, 1, &mut output), Ok(()));
            assert_eq!(output[0].to_bits(), expected.to_bits());
            assert_eq!(output[0].to_bits(), reference(&pixel).to_bits());
        }
    }

    #[test]
    fn seeded_bulk_pixels_and_unaligned_input_match_reference_bytes() {
        let side = 257;
        let count = side * side;
        let mut storage = vec![0; count * 4 + 1];
        let rgba = &mut storage[1..];
        let mut seed = 0x4f53_4653_u32;
        for pixel in rgba.as_chunks_mut::<4>().0 {
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            pixel.copy_from_slice(&[seed as u8, (seed >> 8) as u8, (seed >> 16) as u8, 255]);
        }
        let mut output = vec![f32::NAN; count];
        assert_eq!(
            decode_rgba(rgba, side as u32, side as u32, &mut output),
            Ok(())
        );
        for (pixel, actual) in rgba.as_chunks::<4>().0.iter().zip(output) {
            assert_eq!(actual.to_le_bytes(), reference(pixel).to_le_bytes());
        }
    }

    #[test]
    fn every_alpha_hole_is_rejected_before_output_changes() {
        for alpha in 0..255 {
            for offset in [3, 7, 11, 15] {
                let mut rgba = [255; 16];
                rgba[offset] = alpha;
                let mut output = [f32::from_bits(0x7fc0_1234); 4];
                let original = output.map(f32::to_bits);
                assert_eq!(
                    decode_rgba(&rgba, 2, 2, &mut output),
                    Err(DecodeError::MissingSamples)
                );
                assert_eq!(output.map(f32::to_bits), original);
            }
        }
    }

    #[test]
    fn shape_length_and_hard_bounds_have_distinct_ordered_errors() {
        let mut output = [123.0];
        for (width, height) in [
            (0, 0),
            (1, 2),
            (MAX_SIDE + 1, MAX_SIDE + 1),
            (u32::MAX, u32::MAX),
        ] {
            assert_eq!(
                decode_rgba(&[], width, height, &mut output),
                Err(DecodeError::Dimensions)
            );
        }
        assert_eq!(
            decode_rgba(&[255; 3], 1, 1, &mut output),
            Err(DecodeError::RgbaLength)
        );
        assert_eq!(
            decode_rgba(&[255; 4], 1, 1, &mut []),
            Err(DecodeError::OutputLength)
        );
        assert_eq!(
            decode_rgba(&[255; 3], 1, 1, &mut []),
            Err(DecodeError::RgbaLength)
        );
        assert_eq!(output, [123.0]);
        assert_eq!(dimensions(MAX_SIDE, MAX_SIDE), Ok(MAX_PIXELS));
    }

    #[test]
    fn registry_only_decodes_and_frees_matching_live_owned_buffers() {
        let mut registry = Registry::default();
        let rgba = registry.alloc_rgba(4);
        let out = registry.alloc_heights(1);
        assert_ne!(rgba, 0);
        assert_ne!(out, 0);
        assert_eq!(out % 4, 0);
        registry.rgba[0].copy_from_slice(&[129, 0, 64, 255]);
        assert_eq!(registry.decode(rgba, 4, 1, 1, out, 1), Ok(()));
        assert_eq!(registry.heights[0][0].to_bits(), 256.25_f32.to_bits());
        for pointer in [0, rgba + 1, usize::MAX, out] {
            assert_eq!(
                registry.free_rgba(pointer, 4),
                Err(DecodeError::InvalidAllocation)
            );
        }
        assert_eq!(
            registry.free_rgba(rgba, 3),
            Err(DecodeError::InvalidAllocation)
        );
        assert_eq!(
            registry.free_heights(out, 2),
            Err(DecodeError::InvalidAllocation)
        );
        assert_eq!(
            registry.decode(rgba + 1, 4, 1, 1, out, 1),
            Err(DecodeError::InvalidAllocation)
        );
        assert_eq!(
            registry.decode(rgba, 4, 1, 1, rgba, 1),
            Err(DecodeError::InvalidAllocation)
        );
        assert_eq!(registry.live_bytes, 8);
        assert_eq!(registry.free_rgba(rgba, 4), Ok(()));
        assert_eq!(
            registry.free_rgba(rgba, 4),
            Err(DecodeError::InvalidAllocation)
        );
        assert_eq!(
            registry.decode(rgba, 4, 1, 1, out, 1),
            Err(DecodeError::InvalidAllocation)
        );
        assert_eq!(registry.free_heights(out, 1), Ok(()));
        assert_eq!(registry.live_bytes, 0);
    }

    #[test]
    fn allocation_limits_and_released_budget_are_enforced() {
        let mut registry = Registry::default();
        assert_eq!(registry.alloc_rgba(0), 0);
        assert_eq!(registry.alloc_rgba(MAX_BUFFER_BYTES as u32 + 1), 0);
        assert_eq!(registry.alloc_rgba(u32::MAX), 0);
        assert_eq!(registry.alloc_heights(0), 0);
        assert_eq!(registry.alloc_heights(MAX_PIXELS as u32 + 1), 0);
        assert_eq!(registry.alloc_heights(u32::MAX), 0);
        for _ in 0..MAX_LIVE_BUFFERS {
            assert_ne!(registry.alloc_rgba(1), 0);
        }
        assert_eq!(registry.alloc_rgba(1), 0);
        assert_eq!(registry.alloc_heights(1), 0);
        let pointer = registry.rgba[0].as_ptr() as usize;
        assert_eq!(registry.free_rgba(pointer, 1), Ok(()));
        assert_ne!(registry.alloc_heights(1), 0);
        // Check the exact 128MiB arithmetic without allocating 128MiB in a unit test.
        registry.rgba.clear();
        registry.heights.clear();
        registry.live_bytes = MAX_LIVE_BYTES - 4;
        assert!(registry.can_allocate(4));
        assert!(!registry.can_allocate(5));
        registry.live_bytes = MAX_LIVE_BYTES;
        assert!(!registry.can_allocate(1));
        registry.live_bytes = usize::MAX;
        assert!(!registry.can_allocate(1));
    }

    #[test]
    fn public_abi_uses_registry_handles_and_never_dereferences_unknown_pointers() {
        assert_eq!(raster_abi_version(), 1);
        assert_eq!(raster_alloc_rgba(0), 0);
        assert_eq!(raster_decode(usize::MAX, 4, 1, 1, usize::MAX, 1), 5);
        assert_eq!(raster_decode(0, 4, 0, 0, 0, 1), 1);
        assert_eq!(raster_decode(0, 3, 1, 1, 0, 1), 2);
        assert_eq!(raster_decode(0, 4, 1, 1, 0, 0), 3);
        let rgba = raster_alloc_rgba(4);
        let output = raster_alloc_heights(1);
        assert_ne!(rgba, 0);
        assert_ne!(output, 0);
        REGISTRY
            .with(|registry| registry.borrow_mut().rgba[0].copy_from_slice(&[127, 255, 128, 255]));
        assert_eq!(raster_decode(rgba, 4, 1, 1, output, 1), 0);
        REGISTRY.with(|registry| {
            assert_eq!(
                registry.borrow().heights[0][0].to_bits(),
                (-0.5_f32).to_bits()
            )
        });
        assert_eq!(raster_free_rgba(rgba, 4), 0);
        assert_eq!(raster_free_rgba(rgba, 4), 5);
        assert_eq!(raster_free_heights(output, 1), 0);
        REGISTRY.with(|registry| assert_eq!(registry.borrow().live_bytes, 0));
    }

    #[test]
    fn reentrant_registry_access_returns_failure_instead_of_panicking() {
        REGISTRY.with(|registry| {
            let _held = registry.borrow_mut();
            assert_eq!(raster_alloc_rgba(4), 0);
            assert_eq!(raster_free_rgba(0, 4), 5);
            assert_eq!(raster_decode(0, 4, 1, 1, 0, 1), 5);
        });
    }
}
