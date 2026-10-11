import { createGlobeOverviewBinding, type GlobeOverview } from "@foss-earth/engine";
import { createBrowserGlobeBindings, loadBrowserGlobeGoogleProviders, type BrowserGlobeBindingOptions, type BrowserGlobeGoogleProviders } from "@foss-earth/engine/browser-globe";
import { createGlobeRuntime, type GlobeRuntimeOptions, type SettledGlobeRuntime, NativeMapStartupError } from "@foss-earth/engine/babylon";
import { createBoundedAtlasImageryLoader, createAtlasImageryWorkerBridge, type SettledBrowserImageryLoader, type SettledAtlasImageryWorkerBridge } from "@foss-earth/engine/browser";
export function bindBrowser(input: BrowserGlobeBindingOptions) {
  const binding = createBrowserGlobeBindings(input);
  const platform: GlobeRuntimeOptions["platform"] = binding.platform;
  const map: GlobeRuntimeOptions["mapPorts"] = binding.mapPorts;
  const retirement: () => Promise<void> = binding.whenSettled;
  return { binding, platform, map, retirement };
}
export function createBorrowedGlobe(canvas: HTMLCanvasElement, input: GlobeRuntimeOptions): SettledGlobeRuntime {
  return createGlobeRuntime(canvas, input);
}
export function overviewContract(input: Parameters<typeof createGlobeOverviewBinding>[0], authored: GlobeOverview) {
  const binding = createGlobeOverviewBinding(input);
  const result = binding.showOverview(authored);
  return { result, retire: binding.dispose, whenSettled: binding.whenSettled };
}
export function settlementContract(loader: ReturnType<typeof createBoundedAtlasImageryLoader>, worker: ReturnType<typeof createAtlasImageryWorkerBridge>) {
  const held: SettledBrowserImageryLoader = loader;
  const native: SettledAtlasImageryWorkerBridge = worker;
  return [held.whenSettled(), native.whenSettled()];
}
export function partialStartupContract(failure: NativeMapStartupError): Promise<void> { return failure.whenSettled(); }
export function nativeProviderContract(): Promise<BrowserGlobeGoogleProviders> { return loadBrowserGlobeGoogleProviders(); }
