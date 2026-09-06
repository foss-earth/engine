import { Texture, type Scene } from "@babylonjs/core";
import { measureMapResponse } from "./mapDownloadMeter";

/** Fetch once, count payload chunks, then let Babylon decode the local blob. */
export function loadMapTexture(
  url: string,
  scene: Scene,
  onLoad: () => void,
  onError: (message?: string, exception?: unknown) => void,
  onBytes: (bytes: number) => void,
): Texture {
  const abort = new AbortController();
  let blobUrl: string | null = null;
  const releaseBlob = () => {
    if (blobUrl !== null) URL.revokeObjectURL(blobUrl);
    blobUrl = null;
  };
  const texture = new Texture(null, scene, false, false, Texture.TRILINEAR_SAMPLINGMODE,
    () => { releaseBlob(); onLoad(); },
    (message, error) => { releaseBlob(); onError(message, error); },
  );
  texture.name = url;
  texture.onDisposeObservable.add(() => { abort.abort(); releaseBlob(); });
  void fetch(url, { signal: abort.signal, mode: "cors" }).then(async (response) => {
    if (!response.ok) throw new Error(`Map tile request failed (${response.status})`);
    const blob = await measureMapResponse(response, onBytes).blob();
    if (abort.signal.aborted) return;
    blobUrl = URL.createObjectURL(blob);
    texture.updateURL(blobUrl);
  }).catch((error: unknown) => {
    if (abort.signal.aborted) return;
    releaseBlob();
    onError(error instanceof Error ? error.message : String(error), error);
  });
  return texture;
}
