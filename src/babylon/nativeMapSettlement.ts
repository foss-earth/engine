/** Actual owner jobs, including inner work whose queue result was cancelled early. */
export class NativeMapStartupError extends AggregateError {
  readonly whenSettled: () => Promise<void>;
  constructor(failures: readonly unknown[], message: string, whenSettled: () => Promise<void>) {
    const causes = failures.flatMap(error => error instanceof AggregateError ? error.errors as unknown[] : [error]);
    const details = causes.map(error => error instanceof Error ? error.message : String(error)).filter(Boolean).join("; ");
    super(causes, details ? `${message} ${details}` : message);
    this.whenSettled = whenSettled;
    this.name = "NativeMapStartupError";
  }
}
export function createNativeMapSettlement() {
  const pending = new Set<Promise<unknown>>(), failures: unknown[] = [];
  let closed = false;
  const track = <T>(work: Promise<T>): Promise<T> => {
    pending.add(work);
    void work.then(() => pending.delete(work), () => pending.delete(work));
    return work;
  };
  return {
    track,
    run<T>(start: () => T | Promise<T>): Promise<T> {
      if (closed) return Promise.reject(new Error("The map native task owner has retired."));
      const work = (async () => start())();
      return track(work);
    },
    close() { closed = true; },
    recordCleanupFailure(error: unknown) { failures.push(error); },
    async whenSettled() {
      while (pending.size) await Promise.allSettled([...pending]);
      if (failures.length) throw new AggregateError(failures, "Map native cleanup failed.");
    },
  };
}
