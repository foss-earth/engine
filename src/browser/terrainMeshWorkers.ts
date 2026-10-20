import { adoptTerrainNumericGeometry, type TerrainNumericGeometry } from "../../terrain-TS/terrainNumericGeometry.js";
import { createWorkerPool, type WorkerPoolStats, type WorkerPoolTimers } from "./workerPool.js";
import { TERRAIN_MESH_PROTOCOL, type TerrainMeshActualBackend, type TerrainMeshNumericInput, type TerrainMeshRequestedBackend,
  type TerrainMeshValidation, type TerrainMeshWorkerPort, type TerrainMeshWorkerReply, type TerrainMeshWorkerRequest } from "./terrainMeshWorkerProtocol.js";

export interface TerrainMeshWorkersOptions {
  createWorker(): TerrainMeshWorkerPort | null;
  workers(): number;
  generation(): number;
  requestedBackend(): TerrainMeshRequestedBackend;
  timers: WorkerPoolTimers;
  nowMs(): number;
  idleMs: number;
  onError(error: unknown): void;
}
export interface PreparedTerrainWorkerGeometry {
  geometry: TerrainNumericGeometry;
  generation: number;
  requestedBackend: TerrainMeshRequestedBackend;
  actualBackend: TerrainMeshActualBackend;
  validationStatus: TerrainMeshValidation;
  parity?: "unchecked" | "same" | "different" | "not compared";
  fallbackReason?: string | null;
}
export interface TerrainMeshWorkerPoolStats extends WorkerPoolStats {
  targets: number;
  actualBackend: TerrainMeshActualBackend;
  parity: "unchecked" | "same" | "different" | "not compared";
  fallbackReason: string | null;
  meanMs: number;
}
export class StaleTerrainMeshResultError extends Error {
  constructor() { super("Terrain mesh result belongs to a retired map generation."); this.name = "StaleTerrainMeshResultError"; }
}

/** Explicit opt-in pool. It never runs work on the page or changes the requested backend. */
export function createTerrainMeshWorkers(options: TerrainMeshWorkersOptions): {
  prepare(input: TerrainMeshNumericInput, request?: { signal?: AbortSignal; priority?: number }): Promise<PreparedTerrainWorkerGeometry>;
  stats(): TerrainMeshWorkerPoolStats;
  dispose(): void;
} {
  const pool = createWorkerPool<TerrainMeshWorkerRequest, TerrainMeshWorkerReply>({ createWorker: options.createWorker,
    size: options.workers, timers: options.timers, nowMs: options.nowMs, idleMs: options.idleMs, onError: options.onError });
  let targets = 0;
  let totalMs = 0;
  let lastActualBackend: TerrainMeshActualBackend = options.requestedBackend() === "wasm" ? "wasm-single" : "typescript";
  let lastParity: "unchecked" | "same" | "different" | "not compared" = options.requestedBackend() === "wasm" ? "unchecked" : "not compared";
  let lastFallbackReason: string | null = null;
  return {
    async prepare(input, request = {}) {
      const generation = options.generation(), requestedBackend = options.requestedBackend();
      if (!Number.isSafeInteger(generation) || generation < 0 || (requestedBackend !== "typescript" && requestedBackend !== "wasm")) throw new Error("Invalid terrain mesh worker selection.");
      const started = options.nowMs();
      // Structured clone retains the host's source buffers for explicit fallback.
      // Never transfer a grid still read by ground queries or another tile.
      const reply = await pool.run({ priority: request.priority, signal: request.signal, message: id => {
        if (generation !== options.generation()) throw new StaleTerrainMeshResultError();
        return { kind: "prepare-terrain-mesh", protocol: TERRAIN_MESH_PROTOCOL, id, generation, requestedBackend, input };
      } });
      request.signal?.throwIfAborted();
      if (reply.generation !== generation || generation !== options.generation()) throw new StaleTerrainMeshResultError();
      if (reply.protocol !== TERRAIN_MESH_PROTOCOL || reply.requestedBackend !== requestedBackend) throw new Error("Terrain mesh worker reply changed its protocol or backend.");
      if (reply.kind === "terrain-mesh-failed") {
        const error = new Error(reply.error.message); error.name = reply.error.name; throw error;
      }
      if (reply.kind !== "prepared-terrain-mesh") throw new Error("Terrain mesh worker reply was not prepared.");
      const elapsed = options.nowMs() - started;
      targets += 1;
      totalMs += elapsed;
      if (reply.actualBackend) lastActualBackend = reply.actualBackend;
      if (reply.parity) lastParity = reply.parity;
      if (reply.fallbackReason) lastFallbackReason = reply.fallbackReason;
      // The worker transferred these arrays; nothing else holds them.
      return { geometry: adoptTerrainNumericGeometry(reply.geometry), generation, requestedBackend,
        actualBackend: reply.actualBackend, validationStatus: reply.validationStatus, parity: reply.parity, fallbackReason: reply.fallbackReason };
    },
    stats: () => ({
      ...pool.stats(),
      targets,
      actualBackend: lastActualBackend,
      parity: lastParity,
      fallbackReason: lastFallbackReason,
      meanMs: targets > 0 ? totalMs / targets : 0,
    }),
    dispose: () => pool.dispose(),
  };
}
