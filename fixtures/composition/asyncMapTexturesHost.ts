/** Public-only prepared composition; one actual common service/uploader/broker
 * arrives through ports. Metadata and cancellation realms remain host-owned. */
import { createBoundedMapTextureLoader, type BoundedMapTexturePorts, type AsyncRasterMapTextures } from "@foss-earth/engine/babylon";
export function bindAsyncRasterTextures(host: {
  images: BoundedMapTexturePorts;
  resolve: AsyncRasterMapTextures["resolve"];
  createAbortController: AsyncRasterMapTextures["createAbortController"];
}): AsyncRasterMapTextures {
  const acquire = createBoundedMapTextureLoader(host.images);
  return {
    resolve(source, tile, url) { return host.resolve(source, tile, url); },
    acquire(file, request) { return acquire(file, request); },
    createAbortController() { return host.createAbortController(); },
  };
}
