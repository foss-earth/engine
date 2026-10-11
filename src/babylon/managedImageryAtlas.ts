import { ResourceCapacityError, type ImageSessionBroker, type PoolName } from "@foss-earth/images";
import type { ManagedImageryAtlasResources } from "./imagery/imageryAtlas.js";

/** Engine atlas policy over the host's ONE borrowed Images broker. */
export function createManagedImageryAtlasResources(broker: ImageSessionBroker): ManagedImageryAtlasResources {
  const reserve = (pool: PoolName, bytes: number, label: string) => {
    const grant = broker.pools.reserve(pool, bytes, label); return grant.ok ? grant.reservation : null;
  };
  return {
    generation: () => broker.generation(),
    reserveGpu(bytes, label, flags) { const grant = broker.pools.reserve("sourceGpu", bytes, label, flags); return grant.ok ? grant.reservation : null; },
    reserveTable: (bytes, label) => reserve("decoded", bytes, label),
    reserveCopy(bytes, label) { const grant = broker.pools.reserve("decoded", bytes, label); if (!grant.ok) throw new ResourceCapacityError(grant.pool, grant.reason); return grant.reservation; },
    canUpload: (bytes, extra = 0) => broker.pools.fits("uploadOutstanding", bytes) && broker.pools.fits("decoded", bytes + extra),
    subscribeAvailable: listener => broker.pools.subscribeAvailable(listener),
    capacityKey() {
      const stats = broker.pools.stats();
      return JSON.stringify((["sourceGpu", "decoded", "encoded", "uploadOutstanding", "overlap"] as const)
        .map(name => [name, stats[name].limit, stats[name].reserved]));
    },
  };
}
