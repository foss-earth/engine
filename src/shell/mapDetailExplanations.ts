import type { ImageryConstraint, ImageryConstraintCause } from "../terrain/imagery/imageryConstraints";
import type { DetailLimit } from "../terrain/mapDetailPolicy";

const count = (value: number, one: string, many = `${one}s`): string => `${value} ${value === 1 ? one : many}`;
const mebibytes = (value: number): string => `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10} MiB`;
/** A counted subject with its verb: "1 region needs", "3 regions need". */
const act = (value: number, one: string, singular: string, plural: string, many = `${one}s`): string => `${count(value, one, many)} ${value === 1 ? singular : plural}`;
const list = (parts: readonly string[]): string => parts.length < 2 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;

/** The detail limit each kind of constraint explains. */
export const CONSTRAINT_LIMIT: Record<ImageryConstraintCause, DetailLimit> = {
  source: "source",
  "gpu-budget": "memory",
  "atlas-full": "memory",
  "page-tables": "backend",
  "binding-depth": "backend",
  "node-cap": "backend",
  renderer: "backend",
  reload: "loading",
};

const NAME: Record<ImageryConstraintCause, string> = {
  source: "the map source",
  "gpu-budget": "the GPU budget",
  "atlas-full": "a full imagery atlas",
  "page-tables": "the page tables",
  "binding-depth": "how far terrain patches reach",
  "node-cap": "the selection limit",
  renderer: "this renderer",
  reload: "a reload",
};

const RELOAD_REASON: Record<"gpu-budget" | "page-tables" | "context-restored", string> = {
  "gpu-budget": "the GPU budget changed",
  "page-tables": "the page tables changed",
  "context-restored": "the graphics context was lost and restored",
};

const reducedText = (regions: number): string => (regions > 0 ? ` ${act(regions, "region", "shown finer before is", "shown finer before are")} coarser now.` : "");

/**
 * One or two sentences on a limit to visible 2D imagery: what limits it, its
 * value, and what it does, all from the runtime's numbers. `still` words it
 * as an update of a limit already reported.
 */
export function describeImageryConstraint(constraint: ImageryConstraint, still = false): string {
  const limited = still ? "is still limited by" : "is limited by";
  switch (constraint.cause) {
    case "source": {
      const parts: string[] = [];
      if (constraint.missingRegions > 0) parts.push(`has no imagery for ${count(constraint.missingRegions, "visible region")}`);
      if (constraint.finestLevelRegions > 0) parts.push(`has nothing finer than level ${constraint.finestLevel} for ${count(constraint.finestLevelRegions, "region")}`);
      if (constraint.outsideRegions > 0) parts.push(`does not cover ${count(constraint.outsideRegions, "region")}`);
      if (constraint.scaleRegions > 0) parts.push(`draws ${count(constraint.scaleRegions, "region")} at the level chosen for a readable map scale`);
      const fallback = constraint.missingRegions + constraint.outsideRegions > 0 ? " Where it has no image, the nearest coarser one it has is shown." : "";
      return `2D imagery ${limited} the map source: it ${list(parts)}.${fallback}`;
    }
    case "gpu-budget": {
      const lead = constraint.reducedRegions > 0 ? "2D imagery detail was reduced by" : `2D imagery ${limited}`;
      const capped = constraint.rendererCapped ? ` This renderer's texture size holds the atlas to ${mebibytes(constraint.atlasMiB)}.` : "";
      return `${lead} the GPU budget (${mebibytes(constraint.configuredMiB)}): selection uses ${constraint.selectedPages} of the ${constraint.selectablePages} pages it may use in the ${constraint.atlasPages}-page atlas, and ${act(constraint.regions, "visible region", "needs", "need")} at least ${constraint.morePagesAtLeast} more.${reducedText(constraint.reducedRegions)}${capped}`;
    }
    case "atlas-full":
      return `2D imagery ${limited} a full imagery atlas (GPU budget ${mebibytes(constraint.configuredMiB)}): ${constraint.pinnedPages} of its ${constraint.atlasPages} pages are shown and the rest hold more important imagery, so ${act(constraint.waitingImages, "downloaded image", "waits", "wait")} for a slot.`;
    case "page-tables": {
      const effective = constraint.effective === constraint.configured ? `${constraint.effective} available` : `${constraint.effective} available, ${constraint.configured} set and rounded by the atlas layout`;
      return `2D imagery ${limited} the page tables: ${effective}, ${constraint.needed} needed by visible patches. ${act(constraint.patches, "patch", "draws", "draw", "patches")} one coarser page instead.`;
    }
    case "binding-depth": {
      const parts: string[] = [];
      if (constraint.regions > 0) {
        const levels = constraint.levels;
        const at = levels === null ? "" : levels.min === levels.max ? ` at level ${levels.min}` : ` at levels ${levels.min} to ${levels.max}`;
        parts.push(`${act(constraint.regions, "visible region", "stops", "stop")}${at}`);
      }
      if (constraint.cappedPatches > 0) parts.push(`${act(constraint.cappedPatches, "patch", "shows coarser pages than it holds", "show coarser pages than they hold", "patches")}`);
      return `2D imagery ${limited} how far terrain patches reach: a patch addresses imagery at most ${constraint.tableDepth} levels finer than itself, so ${list(parts)}.`;
    }
    case "node-cap": {
      const lead = constraint.reducedRegions > 0 ? "2D imagery detail was reduced by" : `2D imagery ${limited}`;
      return `${lead} the selection limit (${constraint.configured} regions): ${constraint.examined} were examined and ${act(constraint.regions, "visible region", "keeps", "keep")} coarser imagery.${reducedText(constraint.reducedRegions)}`;
    }
    case "renderer":
      return `2D imagery ${limited} this renderer: WebGL 1 without shader texture LOD picks each imagery page's mip level itself, so page edges and steep views can look coarser.`;
    case "reload": {
      const value = constraint.value === null ? "" : ` to ${constraint.reason === "gpu-budget" ? mebibytes(constraint.value) : constraint.value}`;
      const replaced = constraint.reason === "context-restored" ? "" : ", which replaced the imagery atlas";
      return `2D imagery is loading again: ${RELOAD_REASON[constraint.reason]}${value}${replaced}.`;
    }
  }
}

/** The sentence for a limit that no longer applies. */
export function describeImageryRecovery(constraint: ImageryConstraint): string {
  if (constraint.cause === "reload") return `2D imagery has loaded again after ${RELOAD_REASON[constraint.reason]}.`;
  return `2D imagery is no longer limited by ${NAME[constraint.cause]}.`;
}

/**
 * What makes a later report of the same limit worth a new line: its
 * configured or effective capacity, or a first reduction of shown detail.
 * Counts that move with the view are left out.
 */
export function constraintIdentity(constraint: ImageryConstraint): string {
  switch (constraint.cause) {
    case "gpu-budget": return `${constraint.configuredMiB}/${constraint.atlasPages}/${constraint.selectablePages}/${constraint.rendererCapped}/${constraint.reducedRegions > 0}`;
    case "atlas-full": return `${constraint.configuredMiB}/${constraint.atlasPages}`;
    case "page-tables": return `${constraint.configured}/${constraint.effective}`;
    case "binding-depth": return `${constraint.tableDepth}`;
    case "node-cap": return `${constraint.configured}/${constraint.reducedRegions > 0}`;
    case "reload": return `${constraint.reason}/${constraint.value}`;
    default: return constraint.cause;
  }
}
