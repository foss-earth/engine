import { decodeImageBlob, isBlankImage, preparePages } from "./imageryPagePreparation";

interface PrepareRequest {
  id: number;
  blob: Blob;
}

interface WorkerScope {
  onmessage: ((event: MessageEvent<PrepareRequest>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

const scope = self as unknown as WorkerScope;

/** Decodes map images and builds their atlas pages off the render thread. */
scope.onmessage = (event) => {
  const { id, blob } = event.data;
  void decodeImageBlob(blob).then((decoded) => {
    if (isBlankImage(decoded.data)) {
      scope.postMessage({ id, blank: true });
      return;
    }
    const pages = preparePages(decoded.data, decoded.width, decoded.height);
    const buffers = pages.flatMap(levels => levels.map(level => level.buffer as ArrayBuffer));
    scope.postMessage({ id, width: decoded.width, height: decoded.height, pages }, buffers);
  }).catch((error: unknown) => {
    scope.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  });
};
