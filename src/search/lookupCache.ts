import { searchTuning } from "./searchTuning";

const STORAGE_KEY = "foss-earth.location-lookups.v1";
interface Entry { keys: string[]; storedAt: number; value: unknown }
interface Pending {
  controller: AbortController;
  promise: Promise<unknown>;
  subscribers: number;
}
const entries = new Map<string, Entry>();
const pending = new Map<string, Pending>();
let loaded = false;

function persist(): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify([...entries.values()])); }
  catch { /* Private browsing and a full device still get the in-memory cache. */ }
}

function prune(): boolean {
  const previousSize = entries.size;
  const { cacheMs, cacheEntries } = searchTuning();
  const now = Date.now();
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
    const stored: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
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
export function aliasLookup(key: string, aliases: readonly string[]): void {
  const entry = find(key);
  if (!entry) return;
  const extra = aliases.filter(alias => !entry.keys.includes(alias));
  if (!extra.length) return;
  entry.keys.push(...new Set(extra));
  persist();
}

/** Bounded, device-persistent successful lookups; each caller owns its cancellation. */
export async function cachedLookup<T>(
  key: string,
  signal: AbortSignal,
  valid: (value: unknown) => value is T,
  lookup: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  signal.throwIfAborted();
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
    const controller = new AbortController();
    const created: Pending = { controller, subscribers: 0, promise: Promise.resolve() };
    created.promise = Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return lookup(controller.signal);
    }).then(value => {
      controller.signal.throwIfAborted();
      if (!valid(value)) throw new Error("Invalid location lookup response.");
      entries.set(key, { keys: [key], storedAt: Date.now(), value });
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
    signal.addEventListener("abort", cancel, { once: true });
    shared.promise.then(value => { if (finish()) resolve(value as T); }, error => { if (finish()) reject(error); });
    if (signal.aborted) cancel();
  });
}
