import type { AutoDetailDecision } from "../terrain/autoDetail.js";
import type { RasterDetailFeedback } from "./runtimeContracts.js";
export interface MapDetailLogRuntime {
  onDetailAdjusted(listener: (decision: AutoDetailDecision) => void): () => void;
  onRasterDetailFeedback(listener: () => void): () => void;
  getRasterDetailFeedback(): RasterDetailFeedback | null;
}
import type { GameLog, GameLogLine } from "@foss-earth/ui/browser";
import type { SettingsRegistry } from "@foss-earth/ui/settings";
import type { ImageryConstraint, ImageryConstraintCause } from "../terrain/imagery/imageryConstraints.js";
import { constraintIdentity, describeImageryBudget, describeImageryConstraint, describeImageryRecovery } from "./mapDetailExplanations.js";

/**
 * A limit as the log reports it. A map source at its finest level, or at the
 * level chosen for a readable scale, is drawn as designed, not held back: the
 * Map tab explains both, and the log leaves them out. Null when nothing else
 * is left.
 */
function forLog(constraint: ImageryConstraint): ImageryConstraint | null {
  if (constraint.cause !== "source" || constraint.scaleRegions + constraint.finestLevelRegions === 0) return constraint;
  const rest = { ...constraint, scaleRegions: 0, finestLevelRegions: 0 };
  return rest.missingRegions + rest.outsideRegions > 0 ? rest : null;
}

/**
 * Connect map detail to the host's visible log: every automatic adjustment,
 * and each limit on 2D imagery as it begins, changes its capacity, and ends.
 * A limit has one line, aggregated by cause, reported once delivery has
 * settled so loading does not flicker it; a reload is reported as it starts.
 * The line changes in place, and when the limit ends it says so and then goes,
 * history included. A new source, or leaving 2D imagery, removes the lines.
 */
export function connectMapDetailLog(
  runtime: MapDetailLogRuntime,
  log: Pick<GameLog, "print">,
  settings?: SettingsRegistry,
): () => void {
  const stopAdjustments = runtime.onDetailAdjusted(decision => {
    const levels = Math.round(Math.abs(decision.to - decision.from) * 100) / 100;
    const why = decision.reason === "settings" ? "automatic-adjustment settings changed"
      : `frames averaged ${decision.meanFrameMs.toFixed(1)} ms against a ${decision.goalMs.toFixed(1)} ms goal`;
    log.print(decision.to > decision.from
      ? { text: `Map detail coarsened ${levels} level${levels === 1 ? "" : "s"} to hold the frame time: ${why}.`, tone: "warning" }
      : { text: `Map detail returned ${levels} level${levels === 1 ? "" : "s"} toward what you asked for: ${why}.`, tone: "info" });
  });

  const reported = new Map<ImageryConstraintCause, { identity: string; constraint: ImageryConstraint; line: GameLogLine }>();
  let source: string | null = null;
  const follow = (): void => {
    const feedback = runtime.getRasterDetailFeedback();
    const current = feedback?.support === "ready" && feedback.source ? feedback : null;
    const key = current?.source ? `${current.source.id}@${current.source.version}` : null;
    if (key !== source) {
      // What limited another source says nothing about this one.
      for (const { line } of reported.values()) line.remove();
      reported.clear();
      source = key;
    }
    if (!current) return;
    const settled = !current.pending;
    const constraints = (current.constraints ?? []).map(forLog).filter(constraint => constraint !== null);
    for (const constraint of constraints) {
      if (!settled && constraint.cause !== "reload") continue;
      const identity = `${constraintIdentity(constraint)}/${describeImageryBudget(constraint, settings)}`;
      const previous = reported.get(constraint.cause);
      if (previous?.identity === identity) {
        previous.constraint = constraint;
        continue;
      }
      const entry = { text: describeImageryConstraint(constraint, previous !== undefined, settings), tone: "warning" as const };
      if (previous) previous.line.update(entry);
      reported.set(constraint.cause, { identity, constraint, line: previous?.line ?? log.print(entry) });
    }
    for (const [cause, { constraint, line }] of reported) {
      if (constraints.some(candidate => candidate.cause === cause)) continue;
      if (!settled && cause !== "reload") continue;
      reported.delete(cause);
      line.update({ text: describeImageryRecovery(constraint), tone: "info", keepInHistory: false });
    }
  };
  const stopFeedback = runtime.onRasterDetailFeedback(follow);
  const stopSettings = settings?.subscribe(changed => {
    if (changed.has("map.imagery.gpuBudget")) follow();
  });
  follow();
  return () => {
    stopAdjustments();
    stopFeedback();
    stopSettings?.();
  };
}
