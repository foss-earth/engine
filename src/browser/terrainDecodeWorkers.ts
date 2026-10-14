import type { TerrainImageDecodeLimits } from "./terrainImageDecoder.js";
import { createWorkerPool, WorkerPoolUnavailableError, type WorkerPoolStats, type WorkerPoolTimers } from "./workerPool.js";
import { terrainDecodeError, type TerrainDecodeWorkerPort, type TerrainDecodeWorkerReply, type TerrainDecodeWorkerRequest } from "./terrainDecodeWorkerProtocol.js";

export interface TerrainDecodeWorkersOptions {
  /** A worker running installTerrainDecodeWorkerKernel; null or a throw: decode on the page. */
  createWorker(): TerrainDecodeWorkerPort | null;
  /** The most decode workers at once, read at each dispatch. 0: decode on the page. */
  workers(): number;
  timers: WorkerPoolTimers;
  nowMs(): number;
  /** A worker with nothing to decode for this long stops. */
  idleMs: number;
  limits(): TerrainImageDecodeLimits;
  onError(error: unknown): void;
}
export type TerrainPageDecoder = (blob: Blob) => Promise<{ size: number; heights: Float32Array }>;
export interface TerrainDecodeRequestOptions {
  /** Higher decodes first. */
  priority?: number;
  /** Aborting drops the tile; a worker already decoding it finishes and its result is dropped. */
  signal?: AbortSignal;
}
export interface TerrainDecodeWorkers {
  /** `onPage`: the page's own decoder, used whenever no worker can decode this tile. */
  decode(blob: Blob, onPage: TerrainPageDecoder, request?: TerrainDecodeRequestOptions): Promise<{ size: number; heights: Float32Array }>;
  stats(): WorkerPoolStats & { pageDecodes: number };
  dispose(): void;
}
/**
 * Terrarium tiles decoded by a pool of workers with the page's decoder, so the
 * heights are the page's heights. A tile that no worker can take, for any
 * reason other than the tile itself, is decoded on the page instead.
 */
export function createTerrainDecodeWorkers(options: TerrainDecodeWorkersOptions): TerrainDecodeWorkers {
  let unsupported = false, pageDecodes = 0;
  const pool = createWorkerPool<TerrainDecodeWorkerRequest, TerrainDecodeWorkerReply>({
    createWorker: options.createWorker, size: () => unsupported ? 0 : options.workers(), timers: options.timers,
    nowMs: options.nowMs, idleMs: options.idleMs, onError: options.onError,
  });
  return {
    async decode(blob, onPage, request = {}) {
      const page = (): ReturnType<TerrainPageDecoder> => { pageDecodes++; return onPage(blob); };
      request.signal?.throwIfAborted();
      if (!pool.available()) return page();
      const { maxTileSide } = options.limits();
      let reply: TerrainDecodeWorkerReply;
      try {
        reply = await pool.run({ message: id => ({ kind: "decode-terrain", id, blob, maxTileSide }),
          priority: request.priority, signal: request.signal });
      } catch (error) {
        if (error instanceof WorkerPoolUnavailableError) { request.signal?.throwIfAborted(); return page(); }
        throw error;
      }
      if (reply.kind === "decoded-terrain") {
        const { size, heights } = reply;
        if (!(heights instanceof Float32Array) || !Number.isSafeInteger(size) || heights.length !== size * size) throw new Error("A terrain decode worker returned malformed heights.");
        return { size, heights };
      }
      if (reply.unsupported) {
        // This browser's workers cannot decode (no OffscreenCanvas 2D): an expected
        // capability gap, not an error. Idle workers retire; the page decodes from now on.
        unsupported = true;
        return page();
      }
      throw terrainDecodeError(reply.error);
    },
    stats: () => ({ ...pool.stats(), pageDecodes }),
    dispose: () => pool.dispose(),
  };
}
