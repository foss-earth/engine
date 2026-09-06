import { afterEach, describe, expect, it, vi } from "vitest";
import { createMapDownloadMeter, measureMapResponse } from "./mapDownloadMeter";

afterEach(() => { vi.useRealTimers(); });
describe("map download meter", () => {
  it("aggregates map payload bytes over one second and stops its timer when idle", () => {
    vi.useFakeTimers();
    const meter = createMapDownloadMeter();
    const listener = vi.fn();
    const off = meter.subscribe(listener);
    expect(meter.getBytesPerSecond()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    meter.addBytes(1_000_000);
    meter.addBytes(2_000_000);
    vi.advanceTimersByTime(250);
    expect(meter.getBytesPerSecond()).toBe(3_000_000);
    vi.advanceTimersByTime(1000);
    expect(meter.getBytesPerSecond()).toBe(0);
    expect(listener).toHaveBeenLastCalledWith(0);
    expect(vi.getTimerCount()).toBe(0);
    off();
    meter.addBytes(10);
    meter.destroy();
    expect(vi.getTimerCount()).toBe(0);
    meter.addBytes(20);
    expect(meter.getBytesPerSecond()).toBe(0);
  });

  it("counts chunks without changing response payload, metadata, or errors", async () => {
    const bytes = vi.fn();
    const original = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3]));
        controller.close();
      },
    }), { headers: { "content-type": "application/octet-stream" } });
    Object.defineProperty(original, "url", { value: "https://tiles.example/tile" });
    const response = measureMapResponse(original, bytes);
    expect(response.url).toBe(original.url);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual([1, 2, 3]);
    expect(bytes.mock.calls).toEqual([[2], [1]]);
    const error = new Response("failed", { status: 500 });
    expect(measureMapResponse(error, bytes)).toBe(error);
  });

  it("propagates cancellation to the original stream", async () => {
    const cancel = vi.fn();
    const original = new Response(new ReadableStream({ cancel }));
    const measured = measureMapResponse(original, vi.fn());
    await measured.body!.cancel();
    await vi.waitFor(() => expect(cancel).toHaveBeenCalled());
  });
});
