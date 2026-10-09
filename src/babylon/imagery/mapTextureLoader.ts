import type { Texture, Scene } from "@babylonjs/core";
import type { createPendingImageTexture, PendingImageBody } from "@foss-earth/renderer/babylon";
import { measureMapResponse } from "../../browser/mapDownloadMeter.js";

export interface MapTexturePorts {
  createPendingImageTexture: typeof createPendingImageTexture;
  /** Host map cache/transport/admission; no image-viewer queue capacity is substituted. */
  fetchMapTile(url: string, options: RequestInit): Promise<Response>;
  reserveBody(blob: Blob, label: string): PendingImageBody;
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
  realm: { Response: typeof Response; TransformStream: typeof TransformStream };
}

/** Legacy sampling/gamma and synchronous pending Texture, backend-owned.
 * Babylon's hidden decode/upload is not admitted by the shared image broker;
 * use createBoundedMapTextureLoader for the explicit async accounted path.
 */
export function createMapTextureLoader(ports: MapTexturePorts) {
  return function loadMapTexture(url: string, scene: Scene, onLoad: () => void,
    onError: (message?: string, exception?: unknown) => void, onBytes: (bytes: number) => void): Texture {
    return ports.createPendingImageTexture({ label: url, scene, createObjectURL: ports.createObjectURL,
      revokeObjectURL: ports.revokeObjectURL, onLoad, onError,
      acquire: async signal => {
        const response = await ports.fetchMapTile(url, { signal, mode: "cors" });
        if (!response.ok) throw new Error(`Map tile request failed (${response.status})`);
        const blob = await measureMapResponse(response, onBytes, ports.realm).blob();
        signal.throwIfAborted();
        return ports.reserveBody(blob, url);
      },
    });
  };
}
