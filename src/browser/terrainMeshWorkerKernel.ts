import { copyTerrainNumericGeometry, prepareTerrainNumericGeometry, validateTerrainNumericRequest } from "../terrain/terrainNumericGeometry.js";
import { TERRAIN_MESH_PROTOCOL, type NativeTerrainGeometryPort, type TerrainMeshActualBackend,
  type TerrainMeshWorkerRequest, type TerrainMeshWorkerScope } from "./terrainMeshWorkerProtocol.js";

export interface TerrainMeshWorkerKernelPorts {
  scope: TerrainMeshWorkerScope;
  /** Explicit native injection. Missing WASM never silently becomes TypeScript. */
  native?: NativeTerrainGeometryPort;
  onError(error: unknown): void;
}

/** Install only in an owning worker. Native output remains unvalidated until later parity work. */
export function installTerrainMeshWorkerKernel(ports: TerrainMeshWorkerKernelPorts): { dispose(): void } {
  const { scope } = ports;
  let disposed = false;
  const report = (error: unknown): void => { try { ports.onError(error); } catch { /* Error port was attempted. */ } };
  const run = async (request: TerrainMeshWorkerRequest): Promise<void> => {
    let actualBackend: TerrainMeshActualBackend | null = null;
    const validationStatus = request?.requestedBackend === "typescript" ? "reference" as const : "unvalidated" as const;
    try {
      if (disposed) throw new Error("Terrain mesh worker is disposed.");
      if (request?.kind !== "prepare-terrain-mesh" || request.protocol !== TERRAIN_MESH_PROTOCOL
        || !Number.isSafeInteger(request.id) || request.id < 1 || !Number.isSafeInteger(request.generation) || request.generation < 0
        || (request.requestedBackend !== "typescript" && request.requestedBackend !== "wasm")) throw new Error("Invalid terrain mesh worker protocol.");
      // Arbitrary callbacks cannot be transferred or interpreted as ground.
      if ("getSurfaceHeightMeters" in request.input) throw new Error("Terrain mesh worker jobs need prepared numeric heights, not callbacks.");
      validateTerrainNumericRequest(request.input);
      let produced;
      if (request.requestedBackend === "typescript") {
        actualBackend = "typescript";
        produced = prepareTerrainNumericGeometry(request.input);
      } else {
        if (!ports.native || ports.native.actualTier !== "single") throw new Error("Requested native terrain core is unavailable; no backend was substituted.");
        actualBackend = "wasm-single";
        produced = await ports.native.buildSurface(request.input);
      }
      if (disposed) return;
      const geometry = copyTerrainNumericGeometry(produced);
      const expectedSegments = Math.max(1, Math.round(request.input.segments ?? 64));
      if (geometry.segments !== expectedSegments || geometry.terrainZoom !== (request.input.grid?.z ?? -1)
        || (request.input.withUvs === false ? geometry.uvs !== null : geometry.uvs === null)) throw new Error("Terrain mesh output disagrees with its request.");
      const transfer: Transferable[] = [geometry.positions.buffer as ArrayBuffer, geometry.targetPositions.buffer as ArrayBuffer,
        geometry.indices.buffer as ArrayBuffer];
      if (geometry.uvs) transfer.push(geometry.uvs.buffer as ArrayBuffer);
      scope.postMessage({ kind: "prepared-terrain-mesh", protocol: TERRAIN_MESH_PROTOCOL, id: request.id, generation: request.generation,
        requestedBackend: request.requestedBackend, actualBackend, validationStatus, geometry }, transfer);
    } catch (error) {
      if (disposed) return;
      scope.postMessage({ kind: "terrain-mesh-failed", protocol: TERRAIN_MESH_PROTOCOL, id: request?.id, generation: request?.generation,
        requestedBackend: request?.requestedBackend, actualBackend, validationStatus,
        error: { name: error instanceof Error ? error.name : "Error", message: error instanceof Error ? error.message : String(error) } });
    }
  };
  const receive = (event: MessageEvent<TerrainMeshWorkerRequest>): void => { void run(event.data).catch(report); };
  scope.onmessage = receive;
  return { dispose() {
    if (disposed) return;
    disposed = true;
    if (scope.onmessage === receive) scope.onmessage = null;
    try { ports.native?.dispose?.(); } catch (error) { report(error); }
  } };
}
