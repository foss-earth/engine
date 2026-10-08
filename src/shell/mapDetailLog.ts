import type { BabylonRuntime } from "../engine/babylon/createBabylonRuntime";
import type { GameLog } from "../log/createGameLog";
import type { ImageryConstraint, ImageryConstraintCause } from "../terrain/imagery/imageryConstraints";
import { constraintIdentity, describeImageryConstraint, describeImageryRecovery } from "./mapDetailExplanations";

/**
 * Connect map detail to the host's visible log: every automatic adjustment,
 * and each limit on 2D imagery as it begins, changes its cause or capacity,
 * and ends. Limits are aggregated by cause and reported once delivery has
 * settled, so loading does not flicker them; a reload is reported as it
 * starts. A new source, or leaving 2D imagery, retires what was reported.
 */
export function connectMapDetailLog(
  runtime: Pick<BabylonRuntime, "onDetailAdjusted" | "onRasterDetailFeedback" | "getRasterDetailFeedback">,
  log: Pick<GameLog, "print">,
): () => void {
  const stopAdjustments = runtime.onDetailAdjusted(decision => {
    const levels = Math.round(Math.abs(decision.to - decision.from) * 100) / 100;
    const why = decision.reason === "settings" ? "automatic-adjustment settings changed"
      : `frames averaged ${decision.meanFrameMs.toFixed(1)} ms against a ${decision.goalMs.toFixed(1)} ms goal`;
    log.print(decision.to > decision.from
      ? { text: `Map detail coarsened ${levels} level${levels === 1 ? "" : "s"} to hold the frame time: ${why}.`, tone: "warning" }
      : { text: `Map detail returned ${levels} level${levels === 1 ? "" : "s"} toward what you asked for: ${why}.`, tone: "info" });
  });

  const reported = new Map<ImageryConstraintCause, { identity: string; constraint: ImageryConstraint }>();
  let source: string | null = null;
  const follow = (): void => {
    const feedback = runtime.getRasterDetailFeedback();
    const current = feedback?.support === "ready" && feedback.source ? feedback : null;
    const key = current?.source ? `${current.source.id}@${current.source.version}` : null;
    if (key !== source) {
      // What limited another source says nothing about this one.
      reported.clear();
      source = key;
    }
    if (!current) return;
    const settled = !current.pending;
    const constraints = current.constraints ?? [];
    for (const constraint of constraints) {
      if (!settled && constraint.cause !== "reload") continue;
      const identity = constraintIdentity(constraint);
      const previous = reported.get(constraint.cause);
      reported.set(constraint.cause, { identity, constraint });
      if (previous?.identity === identity) continue;
      log.print({ text: describeImageryConstraint(constraint, previous !== undefined), tone: "warning" });
    }
    for (const [cause, { constraint }] of reported) {
      if (constraints.some(candidate => candidate.cause === cause)) continue;
      if (!settled && cause !== "reload") continue;
      reported.delete(cause);
      log.print({ text: describeImageryRecovery(constraint), tone: "info" });
    }
  };
  const stopFeedback = runtime.onRasterDetailFeedback(follow);
  follow();
  return () => {
    stopAdjustments();
    stopFeedback();
  };
}
