/** Explicitly opt-in, bounded numeric capture. Summaries allocate only on demand. */
const fields = ["frameIntervalMs", "updateCpuMs", "preparationCpuMs", "sampleCpuMs", "samples", "patches",
  "triangles", "fallbacks", "misses", "geometryWrites", "seamPasses", "revisionChanges"] as const;
type Field = typeof fields[number];
export interface TerrainResourceEstimate {
  adoptedTiles: number;
  cachedTiles: number;
  adoptedTriangles: number;
  cachedTriangles: number;
  meshBytes: number;
  textureBytes: number;
  decodedDemBytes: number | null;
  pendingTiles: number;
  activeDemRequests: number | null;
  queuedDemRequests: number | null;
}

export function createTerrainPerformanceCapture(capacity = 3600) {
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 36000) throw new Error("Invalid terrain capture capacity");
  const data = new Float64Array(capacity * fields.length);
  const counters = { samples: 0, patches: 0, triangles: 0, fallbacks: 0, misses: 0,
    geometryWrites: 0, seamPasses: 0, revisionChanges: 0, updateCpuMs: 0, preparationCpuMs: 0, sampleCpuMs: 0 };
  let cursor = 0, count = 0, previousFrame: number | null = null, interval = 0;
  let resources: TerrainResourceEstimate | null = null, resourcesAt = -Infinity;
  let peakMeshBytes = 0, peakTextureBytes = 0;
  return {
    counters,
    beginFrame(now: number): void {
      interval = previousFrame === null ? 0 : Math.max(0, now - previousFrame);
      previousFrame = now;
    },
    endFrame(): void {
      for (let i = 0; i < fields.length; i++) {
        const field = fields[i];
        data[cursor * fields.length + i] = field === "frameIntervalMs" ? interval : counters[field];
        if (field !== "frameIntervalMs") counters[field] = 0;
      }
      cursor = (cursor + 1) % capacity;
      count = Math.min(capacity, count + 1);
    },
    needsResources(now: number): boolean { return now - resourcesAt >= 1000; },
    recordResources(value: TerrainResourceEstimate, now: number): void {
      resources = value; resourcesAt = now;
      peakMeshBytes = Math.max(peakMeshBytes, value.meshBytes);
      peakTextureBytes = Math.max(peakTextureBytes, value.textureBytes);
    },
    snapshot() {
      const metrics = {} as Record<Field, { mean: number; p95: number; p99: number; max: number }>;
      for (let i = 0; i < fields.length; i++) {
        const values = Array.from({ length: count }, (_, row) => data[row * fields.length + i]).sort((a, b) => a - b);
        metrics[fields[i]] = { mean: values.reduce((a, b) => a + b, 0) / Math.max(1, count),
          p95: values[Math.max(0, Math.ceil(count * 0.95) - 1)] ?? 0,
          p99: values[Math.max(0, Math.ceil(count * 0.99) - 1)] ?? 0, max: values[count - 1] ?? 0 };
      }
      return { frames: count, capacity, metrics, resources: resources ? { ...resources } : null,
        sampledPeakMeshBytes: peakMeshBytes, sampledPeakTextureBytes: peakTextureBytes,
        gpuTimeMs: null, processMemoryBytes: null, pendingDecodeBytes: null, drawCalls: null,
        note: "CPU submission times; resource estimates exclude driver/decoder overhead. Resource snapshots at most once per second." };
    },
  };
}
export type TerrainPerformanceCapture = ReturnType<typeof createTerrainPerformanceCapture>;
