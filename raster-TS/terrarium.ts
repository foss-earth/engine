/** Terrarium RGB to metres: the TypeScript twin of raster-WASM's Rust decoder. */
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([0x0a0b0c0d]).buffer)[0] === 0x0d;

export function decodeTerrarium(data: Uint8ClampedArray, size: number): Float32Array {
  if (data.length !== size * size * 4) throw new Error("Invalid terrain image dimensions");
  const heights = new Float32Array(size * size);
  // One little-endian word per pixel. The float32 heights match the byte formula
  // for every colour; an unaligned view keeps the byte formula.
  if (LITTLE_ENDIAN && (data.byteOffset & 3) === 0) {
    const words = new Uint32Array(data.buffer, data.byteOffset, heights.length);
    for (let i = 0; i < heights.length; i++) {
      const w = words[i];
      if ((w >>> 24) !== 0xff) throw new Error("Terrain image contains missing samples");
      heights[i] = ((((w & 0xff) << 16) | (w & 0xff00) | ((w >>> 16) & 0xff)) - 8388608) / 256;
    }
    return heights;
  }
  for (let i = 0; i < heights.length; i++) {
    const offset = i * 4;
    if (data[offset + 3] !== 255) throw new Error("Terrain image contains missing samples");
    heights[i] = data[offset] * 256 + data[offset + 1] + data[offset + 2] / 256 - 32768;
  }
  return heights;
}
