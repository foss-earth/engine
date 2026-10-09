import { IMAGERY_TABLE_BLOCK } from "./imageryAtlasLayout.js";
import { buildPatchTable, type ImageryDisplay, type PatchTable } from "./imageryBinding.js";
import type { TileId } from "./imageryGeometry.js";

export interface HeldPatchTable extends PatchTable {
  retain(): () => void;
  close(): void;
}
export interface ManagedPatchTablePorts {
  reserve(bytes: number, label: string): { release(): void } | null;
}
/** Admit the entire CPU table before allocation; do not mutate the visible table. */
export function prepareManagedPatchTable(display: ImageryDisplay, patch: TileId, ports: ManagedPatchTablePorts): HeldPatchTable | null {
  const bytes = IMAGERY_TABLE_BLOCK ** 2 * 4;
  const grant = ports.reserve(bytes, `imagery patch ${patch.z}/${patch.x}/${patch.y} table`);
  if (!grant) return null;
  let prepared: PatchTable;
  try { prepared = buildPatchTable(display, patch, new Uint8Array(bytes)); }
  catch (error) {
    try { grant.release(); } catch (cleanup) { throw new AggregateError([error, cleanup], "Patch table allocation and cleanup failed."); }
    throw error;
  }
  let data: Uint8Array | null = prepared.data, closing = false, closed = false, users = 0;
  const finish = (): void => { if (closed || !closing || users) return; closed = true; data = null; grant.release(); };
  return {
    cellsLog2: prepared.cellsLog2, capped: prepared.capped, emptyCells: prepared.emptyCells,
    get data() { if (!data || closed) throw new Error("The managed patch table is closed."); return data; },
    retain() {
      if (closing || closed) throw new Error("Cannot retain a closing patch table.");
      users += 1; let held = true;
      return () => { if (!held) return; held = false; users -= 1; finish(); };
    },
    close() { closing = true; finish(); },
  };
}
