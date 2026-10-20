import { decodeTerrarium } from "../../raster-TS/terrarium.js";
import type { WorkerPoolTimers } from "./workerPool.js";

export type NativeTierPreference = "auto" | "typescript" | "single" | "threaded";
export type TerrainNativeFallbackReason = "threaded-unsupported" | "startup-timeout" | "startup-failed"
  | "decode-timeout" | "decode-failed" | "invalid-native-result" | "parity-mismatch";
export interface TerrainNativeDecoderStatus {
  workerId: string;
  requestedTier: NativeTierPreference;
  /** The backend admitted for subsequent inputs, never an optimistic startup claim. */
  actualTier: "typescript" | "single";
  state: "typescript" | "starting" | "checking" | "ready" | "fallback";
  parity: "unchecked" | "same" | "different";
  fallbackReason: TerrainNativeFallbackReason | null;
  nativeAttempts: number;
  nativeDecodes: number;
  typescriptDecodes: number;
}
export interface TerrainNativeModule {
  /** Read-only RGBA input. Return one height per pixel; no page image/renderer work. */
  decodeTerrarium(data: Uint8ClampedArray, size: number): Float32Array | Promise<Float32Array>;
}
export interface TerrainNativeDecoderOptions {
  workerId: string;
  requestedTier: NativeTierPreference;
  /** Worker-hosted module import/compile/init. Nothing starts until the first input. */
  start(): Promise<TerrainNativeModule>;
  timers: WorkerPoolTimers;
  startTimeoutMs?: number;
  decodeTimeoutMs?: number;
}
class NativeTimeout extends Error {}
/**
 * Worker-only numeric port. The host owns module loading; importing this helper
 * loads no binary and starts no work. Each worker checks its first valid input
 * against the original TypeScript decoder and returns that reference result.
 * Any native failure permanently selects TypeScript for this worker's lifetime.
 * Timers bound async startup/decoding, not a blocked synchronous WASM invocation.
 */
export function createTerrainNativeDecoder(options: TerrainNativeDecoderOptions): {
  decode(data: Uint8ClampedArray, size: number): Promise<Float32Array>;
  status(): TerrainNativeDecoderStatus;
} {
  if (!options.workerId || options.workerId.length > 128) throw new RangeError("A native terrain worker needs a bounded nonempty id.");
  if (!["auto", "typescript", "single", "threaded"].includes(options.requestedTier)) throw new RangeError("Unknown native tier.");
  const startTimeoutMs = options.startTimeoutMs ?? 5_000, decodeTimeoutMs = options.decodeTimeoutMs ?? 5_000;
  for (const timeout of [startTimeoutMs, decodeTimeoutMs]) if (!Number.isFinite(timeout) || timeout < 1 || timeout > 60_000) throw new RangeError("Native terrain timeouts must be 1–60000 ms.");
  const status: TerrainNativeDecoderStatus = { workerId: options.workerId, requestedTier: options.requestedTier,
    actualTier: "typescript", state: "typescript", parity: "unchecked", fallbackReason: null,
    nativeAttempts: 0, nativeDecodes: 0, typescriptDecodes: 0 };
  let module: TerrainNativeModule | null = null;
  const fallback = (reason: TerrainNativeFallbackReason): void => {
    module = null; status.actualTier = "typescript"; status.state = "fallback"; status.fallbackReason = reason;
  };
  if (options.requestedTier === "threaded") fallback("threaded-unsupported");
  const reference = (data: Uint8ClampedArray, size: number): Float32Array => {
    status.typescriptDecodes++;
    return decodeTerrarium(data, size);
  };
  function bounded<T>(run: () => T | Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const handle = options.timers.setTimeout(() => { settled = true; reject(new NativeTimeout()); }, timeoutMs);
      void Promise.resolve().then(run).then(value => {
        if (settled) return;
        settled = true; options.timers.clearTimeout(handle); resolve(value);
      }, error => {
        if (settled) return;
        settled = true; options.timers.clearTimeout(handle); reject(error);
      });
    });
  }
  async function run(data: Uint8ClampedArray, size: number): Promise<Float32Array> {
    if (options.requestedTier === "typescript" || status.state === "fallback") return reference(data, size);
    // An invalid first image keeps the reference error and does not start WASM.
    const expected = status.parity === "unchecked" ? reference(data, size) : null;
    if (!module) {
      status.state = "starting";
      try {
        const started = await bounded(options.start, startTimeoutMs);
        if (!started || typeof started.decodeTerrarium !== "function") throw new TypeError("Missing native Terrarium decoder.");
        module = started;
      } catch (error) {
        fallback(error instanceof NativeTimeout ? "startup-timeout" : "startup-failed");
        return expected ?? reference(data, size);
      }
    }
    if (expected) status.state = "checking";
    let actual: Float32Array;
    try {
      status.nativeAttempts++;
      const active = module;
      // A faulty native port cannot mutate the bytes needed for JS fallback.
      actual = await bounded(() => active.decodeTerrarium(data.slice(), size), decodeTimeoutMs);
    } catch (error) {
      fallback(error instanceof NativeTimeout ? "decode-timeout" : "decode-failed");
      return expected ?? reference(data, size);
    }
    if (!(actual instanceof Float32Array) || actual.length !== size * size || !actual.every(Number.isFinite)) {
      fallback("invalid-native-result");
      return expected ?? reference(data, size);
    }
    if (expected) {
      const a = new Uint32Array(actual.buffer, actual.byteOffset, actual.length);
      const b = new Uint32Array(expected.buffer, expected.byteOffset, expected.length);
      if (!a.every((bits, index) => bits === b[index])) {
        status.parity = "different"; fallback("parity-mismatch"); return expected;
      }
      status.parity = "same"; status.actualTier = "single"; status.state = "ready";
      return expected;
    }
    status.nativeDecodes++;
    // The kernel transfers this buffer. Never transfer/detach a module's memory.
    return new Float32Array(actual);
  }
  let tail: Promise<void> = Promise.resolve();
  return {
    decode(data, size) {
      // One module instance has one memory arena; overlapping inputs serialize.
      const result = tail.then(() => run(data, size));
      tail = result.then(() => {}, () => {});
      return result;
    },
    status: () => ({ ...status }),
  };
}
