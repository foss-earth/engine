import { createTerrainRegionDemand, type TerrainRegionDemand, type TerrainRegionOutlineSink } from "../babylon/terrainRegionBounds.js";
import { validateTerrainRegion, type TerrainRegionCoverage, type TerrainRegionLease, type TerrainRegionOptions, type TerrainRegionProgress } from "./terrainRegion.js";

type Point = { x: number; y: number; z: number };

/** A shown region: its demand, and the ECEF box of each map tile its final detail still waits for. */
export interface TerrainRegionDisplay {
  demand: TerrainRegionDemand;
  outlines: readonly (readonly Point[])[];
  /** Changes whenever `outlines` does. */
  revision: number;
}

interface RegionPorts {
  nowMs(): number;
  sourceGeneration(): number;
  coverage(demand: TerrainRegionDemand, tier: "minimum" | "final", outline?: TerrainRegionOutlineSink): TerrainRegionCoverage | null;
  groundHeight(latDeg: number, lonDeg: number): number | null;
  unavailableReason(): string | null;
  beginContinuous(): void;
  endContinuous(): void;
  requestRender(): void;
}

/** One lifetime for loading, evidence and telemetry; presentation and aircraft placement belong to the host. */
export function createTerrainRegions(ports: RegionPorts) {
  const entries = new Set<{ demand: TerrainRegionDemand; display: TerrainRegionDisplay | null; tick(now: number): void; release(): void }>();
  let destroyed = false;
  return {
    demands: (): readonly TerrainRegionDemand[] => [...entries].map(entry => entry.demand),
    /** The regions shown in the world, in the order they were prepared. */
    displays: (): readonly TerrainRegionDisplay[] => [...entries].flatMap(entry => entry.display ? [entry.display] : []),
    tick(now: number): void { for (const entry of [...entries]) entry.tick(now); },
    dispose(): void { destroyed = true; for (const entry of [...entries]) entry.release(); },
    prepare(options: TerrainRegionOptions): TerrainRegionLease {
      if (destroyed) throw new Error("Terrain region owner is disposed.");
      validateTerrainRegion(options);
      let released = false, held = false, lastCheck = -Infinity;
      let previousReady = 0, previousPending = 0, previousAt = ports.nowMs(), lastCompletionAt = previousAt, rate = 0;
      let progress: TerrainRegionProgress = { state: "loading", minimumReady: false, finalReady: false,
        readyTiles: 0, totalTiles: 0, pendingTiles: 0, estimatedRemainingMs: null,
        reason: "Waiting for map coverage around the aircraft.", groundHeightMeters: null, sourceGeneration: ports.sourceGeneration() };
      let signature = "";
      const hold = (on: boolean): void => {
        if (on === held) return;
        held = on;
        if (on) ports.beginContinuous(); else ports.endContinuous();
      };
      const release = (): void => {
        if (released) return;
        released = true; entries.delete(entry); hold(false);
        options.signal?.removeEventListener("abort", release);
        ports.requestRender();
      };
      const entry = {
        demand: createTerrainRegionDemand(structuredClone(options.region), { ...options.minimum }, { ...options.final }),
        display: null as TerrainRegionDisplay | null,
        release,
        tick(now: number): void {
          if (released || now - lastCheck < 150) return;
          lastCheck = now;
          const outlines: Point[][] | null = entry.display ? [] : null;
          const minimum = ports.coverage(entry.demand, "minimum");
          const final = ports.coverage(entry.demand, "final", outlines ? corners => { outlines.push(corners.map(({ x, y, z }) => ({ x, y, z }))); } : undefined);
          if (entry.display && outlines && (entry.display.demand !== entry.demand || JSON.stringify(outlines) !== JSON.stringify(entry.display.outlines))) {
            entry.display = { demand: entry.demand, outlines, revision: entry.display.revision + 1 };
            ports.requestRender();
          }
          const generation = ports.sourceGeneration();
          if (generation !== progress.sourceGeneration) { rate = 0; previousReady = previousPending = 0; previousAt = now; }
          const minimumReady = minimum !== null && !minimum.unavailable && minimum.readyTiles === minimum.totalTiles && minimum.pendingTiles === 0;
          const finalReady = final !== null && !final.unavailable && final.readyTiles === final.totalTiles && final.pendingTiles === 0;
          const unavailable = final?.reason ?? (final?.unavailable || ports.unavailableReason());
          const readyTiles = final?.readyTiles ?? 0, pendingTiles = final?.pendingTiles ?? 0;
          const elapsed = now - previousAt;
          if (elapsed >= 150) {
            const completions = Math.max(0, readyTiles - previousReady, previousPending - pendingTiles);
            if (completions > 0) { lastCompletionAt = now; rate = rate ? rate * 0.75 + completions / elapsed * 0.25 : completions / elapsed; }
            else if (now - lastCompletionAt > 5000) rate = 0;
            previousAt = now; previousReady = readyTiles; previousPending = pendingTiles;
          }
          const center = entry.demand.region.center;
          const groundHeightMeters = ports.groundHeight(center.latDeg, center.lonDeg);
          if (entry.demand.supportRequired !== (groundHeightMeters === null)) {
            entry.demand.supportRequired = groundHeightMeters === null; ports.requestRender();
          }
          progress = { state: finalReady ? "ready" : unavailable ? "unavailable" : minimumReady ? "minimum" : "loading",
            minimumReady, finalReady, readyTiles, totalTiles: final?.totalTiles ?? 0, pendingTiles,
            estimatedRemainingMs: finalReady ? 0 : rate > 0 && pendingTiles > 0 ? Math.min(120_000, pendingTiles / rate) : null,
            reason: finalReady ? null : typeof unavailable === "string" ? unavailable : unavailable
              ? "Map detail around the aircraft is unavailable."
              : minimumReady ? "Refining map detail around the aircraft." : "Waiting for map coverage around the aircraft.",
            groundHeightMeters, sourceGeneration: generation };
          hold((!finalReady || groundHeightMeters === null) && !unavailable);
          const nextSignature = JSON.stringify(progress);
          if (nextSignature !== signature) { signature = nextSignature;
            try { options.onProgress?.({ ...progress }); } catch (error) { release(); throw error; }
          }
        },
      };
      if (!options.signal?.aborted) { entries.add(entry); hold(true); options.signal?.addEventListener("abort", release, { once: true }); ports.requestRender(); }
      else released = true;
      return {
        read() {
          if (!released && ports.sourceGeneration() !== progress.sourceGeneration) {
            rate = 0;
            progress = { ...progress, state: "loading", minimumReady: false, finalReady: false, estimatedRemainingMs: null,
              sourceGeneration: ports.sourceGeneration(), reason: "Preparing the selected map around the aircraft." };
            lastCheck = -Infinity; hold(true); ports.requestRender();
          }
          return { ...progress };
        },
        update(region) {
          if (released) return;
          validateTerrainRegion({ ...options, region });
          if (JSON.stringify(region) === JSON.stringify(entry.demand.region)) return;
          entry.demand = createTerrainRegionDemand(structuredClone(region), { ...options.minimum }, { ...options.final });
          // The shown region moves now; its outlines are measured at the next check.
          if (entry.display) entry.display = { demand: entry.demand, outlines: [], revision: entry.display.revision + 1 };
          lastCheck = -Infinity; rate = 0; previousReady = previousPending = 0; previousAt = ports.nowMs();
          // Report the moved region even when its readiness matches the old one.
          signature = "";
          progress = { ...progress, state: "loading", minimumReady: false, finalReady: false, estimatedRemainingMs: null, reason: "Preparing the aircraft's new map region." };
          hold(true); ports.requestRender();
        },
        setVisible(visible) {
          if (released || visible === (entry.display !== null)) return;
          entry.display = visible ? { demand: entry.demand, outlines: [], revision: 0 } : null;
          lastCheck = -Infinity; ports.requestRender();
        },
        release,
      };
    },
  };
}
