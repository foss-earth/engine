import { fetchMapTile } from "../../../terrain/mapCache";
import { measureMapResponse } from "../mapDownloadMeter";
import { decodeImageBlob, isBlankImage, preparePages } from "./imageryPagePreparation";
import { ImageryMissingError, type ImageryLoader, type PreparedImage } from "./imageryResidency";

interface WorkerReply {
  id: number;
  width?: number;
  height?: number;
  pages?: Uint8Array[][];
  /** The image was fully transparent: the source has no data there. */
  blank?: boolean;
  error?: string;
}

export interface BrowserImageryLoader extends ImageryLoader {
  /** True when decoding runs in a worker. */
  readonly offThread: boolean;
  dispose(): void;
}

function createDecodeWorker(): Worker | null {
  if (typeof Worker === "undefined" || typeof OffscreenCanvas === "undefined") return null;
  try {
    return new Worker(new URL("./imageryDecodeWorker.ts", import.meta.url), { type: "module" });
  } catch {
    return null;
  }
}

/**
 * Fetches map images through the shared map cache and download meter, then
 * decodes them and builds their pages in a worker when the browser has one.
 * A 404, a 204 or a fully transparent image is the source saying it has no
 * such tile; anything else that fails is an error to retry later.
 */
export function createBrowserImageryLoader(options: { onBytes?: (bytes: number) => void } = {}): BrowserImageryLoader {
  let worker = createDecodeWorker();
  let nextId = 1;
  const waiting = new Map<number, { resolve(reply: WorkerReply): void; reject(error: Error): void }>();
  const failWorker = (error: Error): void => {
    for (const pending of waiting.values()) pending.reject(error);
    waiting.clear();
    worker?.terminate();
    worker = null;
  };
  if (worker) {
    worker.onmessage = (event: MessageEvent<WorkerReply>) => {
      const pending = waiting.get(event.data.id);
      if (!pending) return;
      waiting.delete(event.data.id);
      pending.resolve(event.data);
    };
    worker.onerror = () => failWorker(new Error("The imagery decoder stopped."));
  }

  async function prepare(blob: Blob, signal: AbortSignal): Promise<{ width: number; height: number; pages: Uint8Array[][] }> {
    if (worker) {
      const id = nextId++;
      const reply = await new Promise<WorkerReply>((resolve, reject) => {
        waiting.set(id, { resolve, reject });
        worker!.postMessage({ id, blob });
        signal.addEventListener("abort", () => {
          if (waiting.delete(id)) reject(new DOMException("Aborted", "AbortError"));
        }, { once: true });
      });
      if (reply.blank) throw new ImageryMissingError("Map tile has no data");
      if (reply.error || !reply.pages) throw new Error(reply.error ?? "Map imagery could not be decoded.");
      return { width: reply.width!, height: reply.height!, pages: reply.pages };
    }
    const decoded = await decodeImageBlob(blob);
    if (isBlankImage(decoded.data)) throw new ImageryMissingError("Map tile has no data");
    return { width: decoded.width, height: decoded.height, pages: preparePages(decoded.data, decoded.width, decoded.height) };
  }

  return {
    get offThread() { return worker !== null; },
    async load(url, _expected, signal): Promise<PreparedImage> {
      const response = await fetchMapTile(url, { signal, mode: "cors" });
      if (response.status === 404 || response.status === 204) throw new ImageryMissingError(`Map tile not available (${response.status})`);
      if (!response.ok) throw new Error(`Map tile request failed (${response.status})`);
      let bytes = 0;
      const blob = await measureMapResponse(response, (chunk) => {
        bytes += chunk;
        options.onBytes?.(chunk);
      }).blob();
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      const prepared = await prepare(blob, signal);
      return { ...prepared, compressedBytes: bytes || blob.size };
    },
    dispose() {
      failWorker(new Error("The imagery loader was disposed."));
    },
  };
}
