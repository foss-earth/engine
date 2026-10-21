import { IMAGERY_TABLE_BLOCK } from "./imageryAtlasLayout.js";
import { buildPatchTable, type ImageryDisplay, type PatchTable } from "./imageryBinding.js";
import type { TileId } from "./imageryGeometry.js";

export interface HeldPatchTable extends PatchTable {
  readonly unchanged?: false;
  retain(): () => void;
  close(): void;
}
/** A table that matched the one already bound: it keeps its admission until closed, and has no data of its own. */
export interface UnchangedPatchTable extends Omit<PatchTable, "data"> {
  readonly unchanged: true;
  close(): void;
}
export interface ManagedPatchTablePorts {
  reserve(bytes: number, label: string): { release(): void } | null;
}
/** Building into one reused block, so that a table found unchanged allocates nothing. */
export interface PatchTableReuse {
  /** A full table block, overwritten by each call. */
  scratch: Uint8Array;
  /** The patch's patchTableDepth, when the caller has it already. */
  depth?: { cellsLog2: number; capped: boolean };
  /** Whether the built table, valid only during the call, is the one already bound. */
  isBound(built: PatchTable): boolean;
}
/** Admit the entire CPU table before allocation; do not mutate the visible table. */
export function prepareManagedPatchTable(display: ImageryDisplay, patch: TileId, ports: ManagedPatchTablePorts): HeldPatchTable | null;
export function prepareManagedPatchTable(display: ImageryDisplay, patch: TileId, ports: ManagedPatchTablePorts, reuse: PatchTableReuse): HeldPatchTable | UnchangedPatchTable | null;
export function prepareManagedPatchTable(display: ImageryDisplay, patch: TileId, ports: ManagedPatchTablePorts, reuse?: PatchTableReuse): HeldPatchTable | UnchangedPatchTable | null {
  const bytes = IMAGERY_TABLE_BLOCK ** 2 * 4;
  const grant = ports.reserve(bytes, `imagery patch ${patch.z}/${patch.x}/${patch.y} table`);
  if (!grant) return null;
  let prepared: PatchTable;
  try {
    prepared = buildPatchTable(display, patch, reuse ? reuse.scratch : new Uint8Array(bytes), reuse?.depth);
    if (reuse?.isBound(prepared)) {
      const { cellsLog2, capped, emptyCells } = prepared;
      let open = true;
      return { unchanged: true, cellsLog2, capped, emptyCells, close() { if (!open) return; open = false; grant.release(); } };
    }
    if (reuse) prepared = { ...prepared, data: prepared.data.slice() };
  }
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
