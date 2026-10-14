/** Bound to the one host settings registry; no singleton or implicit document. */
export interface VisualizationTunerSettings {
  get(id: string): unknown;
  inspect(id: string): { provenance: string };
  setMany(values: Record<string, number | { min: number; max: number }>): { ok: boolean };
}
export interface VisualizationTunerPorts { document: Document; settings: VisualizationTunerSettings }
