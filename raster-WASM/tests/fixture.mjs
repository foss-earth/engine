/** Explicit ABI mock, not a substitute for the actual Rust parity tests. */
export function rasterFixture(options = {}) {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 4 });
  const calls = [], owned = new Map();
  let cursor = 32;
  const allocate = (kind, length, bytes) => {
    calls.push([`alloc_${kind}`, length]);
    const override = options[`alloc_${kind}`];
    if (override) return override({ memory, calls, owned, length });
    cursor = Math.ceil(cursor / 4) * 4;
    const pointer = cursor;
    cursor += bytes;
    owned.set(pointer, { kind, length });
    if (options.growOnAllocation === kind) memory.grow(1);
    return pointer;
  };
  const free = (kind, pointer, length) => {
    calls.push([`free_${kind}`, pointer, length]);
    const override = options[`free_${kind}`];
    if (override) return override({ memory, calls, owned, pointer, length });
    const entry = owned.get(pointer);
    if (!entry || entry.kind !== kind || entry.length !== length) return 5;
    if (kind === "heights") new Float32Array(memory.buffer, pointer, length).fill(NaN);
    owned.delete(pointer);
    return 0;
  };
  const exports = {
    memory,
    raster_abi_version: () => options.abi ?? 1,
    raster_alloc_rgba: length => allocate("rgba", length, length),
    raster_alloc_heights: length => allocate("heights", length, length * 4),
    raster_free_rgba: (pointer, length) => free("rgba", pointer, length),
    raster_free_heights: (pointer, length) => free("heights", pointer, length),
    raster_decode(rgba, rgbaLength, width, height, heights, outLength) {
      calls.push(["decode", rgba, rgbaLength, width, height, heights, outLength]);
      if (options.decode) return options.decode({ memory, calls, owned, rgba, rgbaLength, width, height, heights, outLength });
      if (options.growOnDecode) memory.grow(1);
      const input = new Uint8Array(memory.buffer, rgba, rgbaLength);
      for (let offset = 3; offset < input.length; offset += 4) if (input[offset] !== 255) return 4;
      const output = new Float32Array(memory.buffer, heights, outLength);
      for (let index = 0; index < outLength; index++) {
        const offset = index * 4;
        output[index] = input[offset] * 256 + input[offset + 1] + input[offset + 2] / 256 - 32768;
      }
      return 0;
    },
  };
  return { exports, memory, calls, owned };
}
