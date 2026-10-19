import { adoptTerrainNumericGeometry, copyTerrainNumericGeometry, prepareTerrainNumericGeometry, validateTerrainNumericRequest } from "../terrain/terrainNumericGeometry.js";
import { TERRAIN_MESH_PROTOCOL, type NativeTerrainGeometryPort, type TerrainMeshActualBackend,
  type TerrainMeshValidation, type TerrainMeshWorkerRequest, type TerrainMeshWorkerScope } from "./terrainMeshWorkerProtocol.js";

export interface TerrainMeshWorkerKernelPorts {
  scope: TerrainMeshWorkerScope;
  /** Explicit native injection. Missing WASM never silently becomes TypeScript. */
  native?: NativeTerrainGeometryPort;
  loadNative?: () => Promise<NativeTerrainGeometryPort>;
  onError(error: unknown): void;
}

/** Install only in an owning worker. Performs first-use parity comparison before admitting WASM. */
export function installTerrainMeshWorkerKernel(ports: TerrainMeshWorkerKernelPorts): { dispose(): void } {
  const { scope } = ports;
  let disposed = false;
  let nativePort: NativeTerrainGeometryPort | null = ports.native ?? null;
  let nativeState: "unchecked" | "ready" | "fallback" = "unchecked";
  let parity: "unchecked" | "same" | "different" | "not compared" = "unchecked";
  let fallbackReason: string | null = null;

  const report = (error: unknown): void => { try { ports.onError(error); } catch { /* Error port was attempted. */ } };
  const run = async (request: TerrainMeshWorkerRequest): Promise<void> => {
    let actualBackend: TerrainMeshActualBackend | null = null;
    let validationStatus: TerrainMeshValidation = request?.requestedBackend === "typescript" ? "reference" : "unvalidated";
    try {
      if (disposed) throw new Error("Terrain mesh worker is disposed.");
      if (request?.kind !== "prepare-terrain-mesh" || request.protocol !== TERRAIN_MESH_PROTOCOL
        || !Number.isSafeInteger(request.id) || request.id < 1 || !Number.isSafeInteger(request.generation) || request.generation < 0
        || (request.requestedBackend !== "typescript" && request.requestedBackend !== "wasm")) throw new Error("Invalid terrain mesh worker protocol.");
      // Arbitrary callbacks cannot be transferred or interpreted as ground.
      if ("getSurfaceHeightMeters" in request.input) throw new Error("Terrain mesh worker jobs need prepared numeric heights, not callbacks.");
      validateTerrainNumericRequest(request.input);
      let produced: ReturnType<typeof prepareTerrainNumericGeometry>;
      if (request.requestedBackend === "typescript") {
        actualBackend = "typescript";
        validationStatus = "reference";
        parity = "not compared";
        produced = prepareTerrainNumericGeometry(request.input);
      } else {
        if (nativeState === "fallback") {
          actualBackend = "typescript";
          validationStatus = "reference";
          produced = prepareTerrainNumericGeometry(request.input);
        } else if (nativeState === "unchecked") {
          if (!nativePort && ports.loadNative) {
            try { nativePort = await ports.loadNative(); }
            catch { nativeState = "fallback"; fallbackReason = "startup-failed"; }
          }
          if (!nativePort || nativePort.actualTier !== "single") {
            nativeState = "fallback";
            fallbackReason = fallbackReason ?? "native-core-unavailable";
            actualBackend = "typescript";
            validationStatus = "reference";
            produced = prepareTerrainNumericGeometry(request.input);
          } else {
            const ref = prepareTerrainNumericGeometry(request.input);
            try {
              const act = await nativePort.buildSurface(request.input);
              const matches = act.targetPositions.length === ref.targetPositions.length
                && Object.is(act.heightBounds.min, ref.heightBounds.min)
                && Object.is(act.heightBounds.max, ref.heightBounds.max)
                && act.targetPositions.every((v, i) => Object.is(v, ref.targetPositions[i]));
              if (matches) {
                parity = "same";
                nativeState = "ready";
                actualBackend = "wasm-single";
                validationStatus = "validated";
                produced = ref;
              } else {
                parity = "different";
                nativeState = "fallback";
                fallbackReason = "parity-mismatch";
                actualBackend = "typescript";
                validationStatus = "reference";
                produced = ref;
              }
            } catch {
              parity = "different";
              nativeState = "fallback";
              fallbackReason = "native-execution-failed";
              actualBackend = "typescript";
              validationStatus = "reference";
              produced = ref;
            }
          }
        } else {
          try {
            actualBackend = "wasm-single";
            validationStatus = "validated";
            parity = "same";
            produced = await nativePort!.buildSurface(request.input);
          } catch {
            nativeState = "fallback";
            fallbackReason = "native-execution-failed";
            actualBackend = "typescript";
            validationStatus = "reference";
            produced = prepareTerrainNumericGeometry(request.input);
          }
        }
      }
      if (disposed) return;
      // TypeScript geometry was allocated for this job; native output may be
      // a view the core reuses, so it is copied before transfer.
      const geometry = actualBackend === "typescript" ? adoptTerrainNumericGeometry(produced) : copyTerrainNumericGeometry(produced);
      const expectedSegments = Math.max(1, Math.round(request.input.segments ?? 64));
      if (geometry.segments !== expectedSegments || geometry.terrainZoom !== (request.input.grid?.z ?? -1)
        || (request.input.withUvs === false ? geometry.uvs !== null : geometry.uvs === null)) throw new Error("Terrain mesh output disagrees with its request.");
      const transfer: Transferable[] = [geometry.positions.buffer as ArrayBuffer, geometry.targetPositions.buffer as ArrayBuffer,
        geometry.indices.buffer as ArrayBuffer];
      if (geometry.uvs) transfer.push(geometry.uvs.buffer as ArrayBuffer);
      scope.postMessage({ kind: "prepared-terrain-mesh", protocol: TERRAIN_MESH_PROTOCOL, id: request.id, generation: request.generation,
        requestedBackend: request.requestedBackend, actualBackend, validationStatus, parity, fallbackReason, geometry }, transfer);
    } catch (error) {
      if (disposed) return;
      scope.postMessage({ kind: "terrain-mesh-failed", protocol: TERRAIN_MESH_PROTOCOL, id: request?.id, generation: request?.generation,
        requestedBackend: request?.requestedBackend, actualBackend, validationStatus, parity, fallbackReason,
        error: { name: error instanceof Error ? error.name : "Error", message: error instanceof Error ? error.message : String(error) } });
    }
  };
  const receive = (event: MessageEvent<TerrainMeshWorkerRequest>): void => { void run(event.data).catch(report); };
  scope.onmessage = receive;
  return { dispose() {
    if (disposed) return;
    disposed = true;
    if (scope.onmessage === receive) scope.onmessage = null;
    try { nativePort?.dispose?.(); } catch (error) { report(error); }
  } };
}
