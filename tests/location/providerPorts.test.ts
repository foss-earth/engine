import { expect,it,vi } from "vitest";
import { createLocationLookupCache,createLocationLookupTransport,createLocationSearchTuning } from "../../src/location-provider.js";
import { LOCATION_LOOKUP_PARAMETERS } from "../../src/settings/catalogue/locationLookup.js";
import { createSettingsRegistry } from "@foss-earth/ui/settings";

it("uses the one host registry live and keeps the Location search homes, units and defaults", () => {
  const settings = createSettingsRegistry({ storage: null });settings.register(LOCATION_LOOKUP_PARAMETERS);
  const tuning = createLocationSearchTuning(settings);
  expect(tuning()).toEqual({ cacheMs: 24*3600000,cacheEntries: 64,timeoutMs: 20000 });
  expect(LOCATION_LOOKUP_PARAMETERS.map(spec => [spec.id,spec.unit,spec.home])).toEqual([
    ["search.cacheDuration","h",{tab:"location",section:"search",level:"main"}],
    ["search.cacheEntries","count",{tab:"location",section:"search",level:"main"}],
    ["search.timeout","s",{tab:"location",section:"search",level:"main"}],
  ]);
  settings.setMany({ "search.cacheDuration": 2,"search.cacheEntries": 3,"search.timeout": 5 });
  expect(tuning()).toEqual({ cacheMs: 7200000,cacheEntries: 3,timeoutMs: 5000 });
});
it("disposes shared pending consumers and never persists an unabortable late answer", async () => {
  let complete!: (value: number) => void;const storage = new Map<string,string>(),cache = createLocationLookupCache({ storage: { getItem: key => storage.get(key) ?? null,setItem: (key,value) => { storage.set(key,value); } },nowMs: () => 100,tuning: () => ({cacheMs:1000,cacheEntries:2,timeoutMs:1000}),createAbortController: () => new AbortController(),abortError: message => new Error(message) });
  const valid = (value: unknown): value is number => typeof value === "number",lookup = vi.fn(() => new Promise<number>(resolve => { complete = resolve; }));
  const first=cache.cachedLookup("pending",new AbortController().signal,valid,lookup).catch(error=>error),second=cache.cachedLookup("pending",new AbortController().signal,valid,lookup).catch(error=>error);
  await Promise.resolve();cache.dispose();expect(await first).toMatchObject({message:"Location lookup cache disposed."});expect(await second).toMatchObject({message:"Location lookup cache disposed."});
  complete(42);await Promise.resolve();await Promise.resolve();expect(storage.size).toBe(0);expect(lookup).toHaveBeenCalledOnce();cache.dispose();
  await expect(cache.cachedLookup("pending",new AbortController().signal,valid,lookup)).rejects.toThrow("disposed");
});
it("preserves transport and both cleanup failures instead of caching a failed request", async () => {
  const operation=new Error("fetch failed"),timerError=new Error("timer stop failed"),signalError=new Error("signal stop failed"),timerStop=vi.fn(()=>{throw timerError;}),signalStop=vi.fn(()=>{throw signalError;});
  const transport=createLocationLookupTransport({ nowMs:()=>0,tuning:()=>({cacheMs:1000,cacheEntries:1,timeoutMs:20}),createAbortController:()=>new AbortController(),combineSignals:signals=>({signal:AbortSignal.any([...signals]),dispose:signalStop}),timeoutError:()=>new Error("timeout"),fetch:async()=>{throw operation;},timers:{setTimeout:()=>1,clearTimeout:timerStop} });
  const failure=await transport.json("https://fixture.invalid/",new AbortController().signal,"Location").catch(error=>error);
  expect(failure).toBeInstanceOf(AggregateError);if (!(failure instanceof AggregateError)) throw new Error("Expected the causal AggregateError.");expect(failure.errors).toEqual([operation,timerError,signalError]);expect(timerStop).toHaveBeenCalledOnce();expect(signalStop).toHaveBeenCalledOnce();
});
it("settles a cancelled provider rate wait even when its supplied timer cleanup throws", async () => {
  const controller=new AbortController(),cancelled=new Error("host cancelled"),cleanup=new Error("rate timer stop failed"),stop=vi.fn(()=>{throw cleanup;});
  const transport=createLocationLookupTransport({ nowMs:()=>0,tuning:()=>({cacheMs:1000,cacheEntries:1,timeoutMs:20}),createAbortController:()=>new AbortController(),combineSignals:signals=>({signal:AbortSignal.any([...signals]),dispose(){}}),timeoutError:()=>new Error("timeout"),fetch:async()=>({ok:true,json:async()=>[]}),timers:{setTimeout:()=>7,clearTimeout:stop} });
  const result=transport.wait(1100,controller.signal).catch(error=>error);controller.abort(cancelled);
  const failure=await result;expect(failure).toBeInstanceOf(AggregateError);if (!(failure instanceof AggregateError)) throw new Error("Expected the causal AggregateError.");expect(failure.errors).toEqual([cancelled,cleanup]);expect(stop).toHaveBeenCalledExactlyOnceWith(7);
});
it("retires an eagerly fired host rate timer after acquiring its handle exactly once", async () => {
  const stop=vi.fn();
  const transport=createLocationLookupTransport({ nowMs:()=>0,tuning:()=>({cacheMs:1000,cacheEntries:1,timeoutMs:20}),createAbortController:()=>new AbortController(),combineSignals:signals=>({signal:AbortSignal.any([...signals]),dispose(){}}),timeoutError:()=>new Error("timeout"),fetch:async()=>({ok:true,json:async()=>[]}),timers:{setTimeout:callback=>{callback();return 8;},clearTimeout:stop} });
  await transport.wait(1100,new AbortController().signal);expect(stop).toHaveBeenCalledExactlyOnceWith(8);
});
