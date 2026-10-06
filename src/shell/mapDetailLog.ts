import type { BabylonRuntime } from "../engine/babylon/createBabylonRuntime";
import type { GameLog } from "../log/createGameLog";

/** Connect every automatic map-detail decision to the host's visible log. */
export function connectMapDetailLog(runtime: Pick<BabylonRuntime, "onDetailAdjusted">, log: Pick<GameLog, "print">): () => void {
  return runtime.onDetailAdjusted(decision => {
    const levels = Math.round(Math.abs(decision.to - decision.from) * 100) / 100;
    const why = decision.reason === "settings" ? "automatic-adjustment settings changed"
      : `frames averaged ${decision.meanFrameMs.toFixed(1)} ms against a ${decision.goalMs.toFixed(1)} ms goal`;
    log.print(decision.to > decision.from
      ? { text: `Map detail coarsened ${levels} level${levels === 1 ? "" : "s"} to hold the frame time: ${why}.`, tone: "warning" }
      : { text: `Map detail returned ${levels} level${levels === 1 ? "" : "s"} toward what you asked for: ${why}.`, tone: "info" });
  });
}
