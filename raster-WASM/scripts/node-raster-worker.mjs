import { parentPort, workerData } from "node:worker_threads";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { decodeTerrarium } from "@foss-earth/engine/raster-TS";
import { instantiateRasterCore } from "../index.js";

const decode = workerData.backend === "typescript" ? decodeTerrarium
  : (await instantiateRasterCore(readFileSync(new URL("../single/raster.wasm", import.meta.url)))).decodeTerrarium;
parentPort.on("message", request => {
  try {
    const { id, data, size, iterations } = request;
    if (!(data instanceof Uint8ClampedArray) || !Number.isInteger(iterations) || iterations < 1 || iterations > 1024) throw new Error("Invalid benchmark job");
    const start = performance.now(); let heights;
    for (let i = 0; i < iterations; i++) heights = decode(data, size);
    const kernelAndCopyMs = performance.now() - start;
    parentPort.postMessage({ id, heights, kernelAndCopyMs, actualBackend: workerData.backend }, [heights.buffer]);
  } catch { parentPort.postMessage({ id: request.id, error: "benchmark-job-failed" }); }
});
parentPort.postMessage({ ready: true, actualBackend: workerData.backend });
