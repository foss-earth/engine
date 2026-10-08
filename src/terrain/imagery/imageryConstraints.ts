/**
 * Why some visible imagery is coarser than the detail asked for, as the
 * decision that applied each limit established it: selection, residency or
 * publication. Counts describe the last plan and publication only; nothing
 * here is a history. A limit that reduced detail already shown says so in
 * `reducedRegions`; otherwise it is a request not met, not a loss.
 */
export type ImageryConstraint =
  | ImagerySourceConstraint
  | ImageryBudgetConstraint
  | ImageryAtlasConstraint
  | ImageryTableConstraint
  | ImageryBindingConstraint
  | ImageryNodeConstraint
  | ImageryRendererConstraint
  | ImageryReloadConstraint;

export type ImageryConstraintCause = ImageryConstraint["cause"];

/** The source has no finer imagery for some visible regions: each shows the nearest image it has. */
export interface ImagerySourceConstraint {
  cause: "source";
  /** Regions whose image the source does not have, or below one it does not have with nothing loaded to show otherwise. */
  missingRegions: number;
  /** Regions at the source's finest level, which is `finestLevel`. */
  finestLevelRegions: number;
  finestLevel: number;
  /** Regions outside the source's coverage. */
  outsideRegions: number;
  /** Map regions at the level chosen for readable scale, which a denser image of the same level cannot help. */
  scaleRegions: number;
}

/** Selection used every page the GPU budget lets it use. */
export interface ImageryBudgetConstraint {
  cause: "gpu-budget";
  parameter: "map.imagery.gpuBudget";
  configuredMiB: number;
  /** The atlas actually allocated. Smaller than the budget allows when the renderer's texture size caps it. */
  atlasMiB: number;
  atlasPages: number;
  rendererCapped: boolean;
  /** Pages selection may use: the atlas, less fallback coverage and room for replacements. */
  selectablePages: number;
  selectedPages: number;
  /** A lower bound: one more level for each stopped region. Finer levels could need more. */
  morePagesAtLeast: number;
  regions: number;
  /** Regions shown finer before that the budget has coarsened since this limit began. */
  reducedRegions: number;
}

/** Downloaded images found no atlas slot: every slot is shown or holds more important imagery. */
export interface ImageryAtlasConstraint {
  cause: "atlas-full";
  parameter: "map.imagery.gpuBudget";
  configuredMiB: number;
  atlasPages: number;
  /** Pages the published display holds; they are never replaced while shown. */
  pinnedPages: number;
  /** Images the last upload could not place. */
  waitingImages: number;
}

/** Visible patches needing a page table outnumber the tables. */
export interface ImageryTableConstraint {
  cause: "page-tables";
  parameter: "map.imagery.pageTablePatches";
  configured: number;
  /** Tables the atlas layout actually has: it rounds the setting to fit its rows. */
  effective: number;
  /** Visible patches whose imagery needs a table. */
  needed: number;
  /** Of those, patches drawing the one coarser page that covers them. */
  patches: number;
}

/** A terrain patch addresses imagery only so many levels below itself. */
export interface ImageryBindingConstraint {
  cause: "binding-depth";
  /** Levels a patch's page table reaches below the patch. */
  tableDepth: number;
  /** The finest imagery levels the terrain allowed where it stopped refinement, coarsest and finest of them. */
  levels: { min: number; max: number } | null;
  regions: number;
  /** Patches whose shown pages were deeper than their table reaches, drawn by coarser pages. */
  cappedPatches: number;
}

/** Selection examined as many regions as `map.imagery.maxNodes` allows. */
export interface ImageryNodeConstraint {
  cause: "node-cap";
  parameter: "map.imagery.maxNodes";
  configured: number;
  examined: number;
  regions: number;
  /** Regions shown finer before that the cap has coarsened since this limit began. */
  reducedRegions: number;
}

/** WebGL 1 without shader texture LOD: the GPU picks each page's mip level from screen derivatives. */
export interface ImageryRendererConstraint {
  cause: "renderer";
  reason: "no-explicit-gradients";
}

/** Shown imagery was discarded and is loading again. */
export interface ImageryReloadConstraint {
  cause: "reload";
  reason: "gpu-budget" | "page-tables" | "context-restored";
  parameter: "map.imagery.gpuBudget" | "map.imagery.pageTablePatches" | null;
  /** The value that took effect, in the parameter's unit (MiB or tables); null for a restored context. */
  value: number | null;
}
