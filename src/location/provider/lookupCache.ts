import type { SearchTuning } from "./searchDefaults.js";
export interface LocationLookupStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }
export interface LocationLookupCachePorts { storage: LocationLookupStorage | null; nowMs(): number; tuning(): SearchTuning; createAbortController(): AbortController; abortError(message: string): unknown }

export const LOCATION_LOOKUP_STORAGE_KEY = "foss-earth.location-lookups.v1";
interface Entry { keys: string[]; storedAt: number; value: unknown }
interface Pending {
  controller: AbortController;
  promise: Promise<unknown>;
  subscribers: number;
}
export function createLocationLookupCache(ports: LocationLookupCachePorts) {
let disposed = false;
const entries = new Map<string, Entry>();
const pending = new Map<string, Pending>();
let loaded = false;

function persist(): void {
  try { ports.storage?.setItem(LOCATION_LOOKUP_STORAGE_KEY, JSON.stringify([...entries.values()])); }
  catch { /* Private browsing and a full device still get the in-memory cache. */ }
}

function prune(): boolean {
  const previousSize = entries.size;
  const { cacheMs, cacheEntries } = ports.tuning();
  const now = ports.nowMs();
  for (const [key, entry] of entries) {
    if (entry.storedAt > now || now - entry.storedAt >= cacheMs) entries.delete(key);
  }
  while (entries.size > cacheEntries) entries.delete(entries.keys().next().value!);
  return entries.size !== previousSize;
}

function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    const stored: unknown = JSON.parse(ports.storage?.getItem(LOCATION_LOOKUP_STORAGE_KEY) ?? "[]");
    if (Array.isArray(stored)) for (const entry of stored) {
      if (entry && Array.isArray(entry.keys) && entry.keys.length && entry.keys.every((key: unknown) => typeof key === "string")
        && typeof entry.storedAt === "number" && Number.isFinite(entry.storedAt) && "value" in entry) {
        entries.set(entry.keys[0], entry as Entry);
      }
    }
  } catch { /* Missing, blocked or damaged storage is a cache miss. */ }
  if (prune()) persist();
}

function find(key: string): Entry | undefined {
  return entries.get(key) ?? [...entries.values()].find(entry => entry.keys.includes(key));
}

/** Add provider aliases without duplicating the answer or extending its lifetime. */
function aliasLookup(key: string, aliases: readonly string[]): void {
  const entry = find(key);
  if (!entry) return;
  const extra = aliases.filter(alias => !entry.keys.includes(alias));
  if (!extra.length) return;
  entry.keys.push(...new Set(extra));
  persist();
}

/** Bounded, device-persistent successful lookups; each caller owns its cancellation. */
async function cachedLookup<T>(
  key: string,
  signal: AbortSignal,
  valid: (value: unknown) => value is T,
  lookup: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  signal.throwIfAborted();
  if (disposed) throw ports.abortError("Location lookup cache disposed.");
  load();
  if (prune()) persist();
  const cached = find(key);
  if (cached) {
    entries.delete(cached.keys[0]);
    if (valid(cached.value)) {
      entries.set(cached.keys[0], cached);
      persist();
      return cached.value;
    }
    persist();
  }
  let request = pending.get(key);
  if (!request) {
    const controller = ports.createAbortController();
    const created: Pending = { controller, subscribers: 0, promise: Promise.resolve() };
    created.promise = Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return lookup(controller.signal);
    }).then(value => {
      controller.signal.throwIfAborted();
      if (disposed) throw ports.abortError("Location lookup cache disposed.");
      if (!valid(value)) throw new Error("Invalid location lookup response.");
      entries.set(key, { keys: [key], storedAt: ports.nowMs(), value });
      prune();
      persist();
      return value;
    }).finally(() => { if (pending.get(key) === created) pending.delete(key); });
    pending.set(key, created);
    request = created;
  }
  const shared = request;
  shared.subscribers++;
  return new Promise<T>((resolve, reject) => {
    let finished = false;
    const finish = () => {
      if (finished) return false;
      finished = true;
      signal.removeEventListener("abort", cancel);
      shared.controller.signal.removeEventListener("abort", upstreamCancelled);
      shared.subscribers--;
      return true;
    };
    const cancel = () => {
      if (!finish()) return;
      if (!shared.subscribers) {
        if (pending.get(key) === shared) pending.delete(key);
        shared.controller.abort(signal.reason);
      }
      reject(signal.reason);
    };
    const upstreamCancelled = () => { if (finish()) reject(shared.controller.signal.reason); };
    shared.controller.signal.addEventListener("abort", upstreamCancelled, { once: true });
    signal.addEventListener("abort", cancel, { once: true });
    shared.promise.then(value => { if (finish()) resolve(value as T); }, error => { if (finish()) reject(error); });
    if (signal.aborted) cancel();
    else if (shared.controller.signal.aborted) upstreamCancelled();
  });
}

return { cachedLookup, aliasLookup, dispose() {
  if (disposed) return; disposed = true;
  const work = [...pending.values()]; pending.clear(); entries.clear();
  const failures: unknown[] = [];
  for (const request of work) {
    let reason: unknown;
    try { reason = ports.abortError("Location lookup cache disposed."); } catch (error) { failures.push(error);reason = error; }
    try { request.controller.abort(reason); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, "Location lookup cache cleanup failed.");
} };
}
export type LocationLookupCache = ReturnType<typeof createLocationLookupCache>;
