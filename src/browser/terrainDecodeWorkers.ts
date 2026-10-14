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
/** Whether a tile decoded in a worker has matched the page's decode: workers are used only once one has. */
export type TerrainDecodeParity = "unchecked" | "checking" | "same" | "different";
export interface TerrainDecodeWorkers {
  /** `onPage`: the page's own decoder, used whenever no worker can decode this tile. */
  decode(blob: Blob, onPage: TerrainPageDecoder, request?: TerrainDecodeRequestOptions): Promise<{ size: number; heights: Float32Array }>;
  stats(): WorkerPoolStats & { pageDecodes: number; parity: TerrainDecodeParity };
  dispose(): void;
}
/**
 * Terrarium tiles decoded by a pool of workers with the page's decoder, so the
 * heights are the page's heights. A tile that no worker can take, for any
 * reason other than the tile itself, is decoded on the page instead.
 */
export function createTerrainDecodeWorkers(options: TerrainDecodeWorkersOptions): TerrainDecodeWorkers {
  let unsupported = false, pageDecodes = 0;
  // Settles true once one tile's worker heights matched the page's bit for bit.
  let parity: Promise<boolean> | null = null, paritySeen: TerrainDecodeParity = "unchecked";
  const pool = createWorkerPool<TerrainDecodeWorkerRequest, TerrainDecodeWorkerReply>({
    createWorker: options.createWorker, size: () => unsupported ? 0 : options.workers(), timers: options.timers,
    nowMs: options.nowMs, idleMs: options.idleMs, onError: options.onError,
  });
  /** The worker's heights; null when no worker can decode this tile. */
  async function onWorker(blob: Blob, request: TerrainDecodeRequestOptions): Promise<{ size: number; heights: Float32Array } | null> {
    const { maxTileSide } = options.limits();
    let reply: TerrainDecodeWorkerReply;
    try {
      reply = await pool.run({ message: id => ({ kind: "decode-terrain", id, blob, maxTileSide }),
        priority: request.priority, signal: request.signal });
    } catch (error) {
      if (error instanceof WorkerPoolUnavailableError) { request.signal?.throwIfAborted(); return null; }
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
      return null;
    }
    throw terrainDecodeError(reply.error);
  }
  /**
   * The first tile is decoded both ways and the page's heights are used. A
   * worker canvas that reads back other bytes than the page's (another color
   * path, another canvas backend) leaves every later tile to the page.
   */
  async function checkParity(blob: Blob, page: () => ReturnType<TerrainPageDecoder>, request: TerrainDecodeRequestOptions) {
    paritySeen = "checking";
    const [onPageResult, onWorkerResult] = await Promise.allSettled([page(), onWorker(blob, request)]);
    const undecided = (): void => { parity = null; paritySeen = "unchecked"; };
    if (onPageResult.status === "rejected" || request.signal?.aborted) {
      // The tile itself failed, or its loader was disposed: the next tile is compared instead.
      undecided();
      request.signal?.throwIfAborted();
      throw (onPageResult as PromiseRejectedResult).reason;
    }
    const expected = onPageResult.value;
    if (onWorkerResult.status === "rejected") {
      // The page decoded a tile the worker could not: the worker is not the page's equal.
      unsupported = true; paritySeen = "different";
      options.onError(onWorkerResult.reason);
      return { result: expected, same: false };
    }
    const actual = onWorkerResult.value;
    if (!actual) {
      // No worker took it. Unless the workers are gone for good, compare the next tile.
      if (!unsupported && pool.available()) undecided();
      return { result: expected, same: false };
    }
    const same = actual.size === expected.size && actual.heights.length === expected.heights.length
      && actual.heights.every((value, index) => Object.is(value, expected.heights[index]));
    paritySeen = same ? "same" : "different";
    if (!same) {
      unsupported = true;
      options.onError(new Error("A terrain decode worker read different heights than the page; elevation tiles decode on the page."));
    }
    return { result: expected, same };
  }
  return {
    async decode(blob, onPage, request = {}) {
      const page = (): ReturnType<TerrainPageDecoder> => { pageDecodes++; return onPage(blob); };
      request.signal?.throwIfAborted();
      if (unsupported || !pool.available()) return page();
      if (!parity) {
        const checked = checkParity(blob, page, request);
        parity = checked.then(outcome => outcome.same, () => false);
        return (await checked).result;
      }
      // Tiles that arrive while the first is compared wait for the verdict.
      if (!await parity) { request.signal?.throwIfAborted(); return page(); }
      return await onWorker(blob, request) ?? page();
    },
    stats: () => ({ ...pool.stats(), pageDecodes, parity: paritySeen }),
    dispose: () => pool.dispose(),
  };
}
