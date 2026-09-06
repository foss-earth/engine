/** Rolling payload receive rate, not a whole-device network bandwidth measurement. */
export function createMapDownloadMeter() {
  const samples: Array<{ time: number; bytes: number }> = [];
  const listeners = new Set<(bytesPerSecond: number) => void>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let rate = 0;
  let disposed = false;
  const publish = (): void => {
    timer = null;
    const cutoff = performance.now() - 1000;
    while (samples.length && samples[0].time <= cutoff) samples.shift();
    const next = samples.reduce((total, sample) => total + sample.bytes, 0);
    if (next !== rate) {
      rate = next;
      for (const listener of listeners) listener(rate);
    }
    if (samples.length && !disposed) timer = setTimeout(publish, 250);
  };
  return {
    addBytes(bytes: number): void {
      if (disposed || !Number.isFinite(bytes) || bytes <= 0) return;
      const time = performance.now();
      const last = samples.at(-1);
      if (last && time - last.time < 50) last.bytes += bytes;
      else samples.push({ time, bytes });
      if (timer === null) publish();
    },
    getBytesPerSecond: () => rate,
    subscribe(listener: (bytesPerSecond: number) => void): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    destroy(): void {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      samples.length = 0;
      rate = 0;
      listeners.clear();
    },
  };
}

/** Count the existing response stream without cloning it or issuing another request. */
export function measureMapResponse(response: Response, onBytes: (bytes: number) => void): Response {
  if (!response.body || !response.ok) return response;
  const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      onBytes(chunk.byteLength);
      controller.enqueue(chunk);
    },
  }));
  const measured = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  // Response construction otherwise drops these fetch-provided metadata fields.
  for (const key of ["url", "redirected", "type"] as const) {
    Object.defineProperty(measured, key, { value: response[key] });
  }
  return measured;
}
