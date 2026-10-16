import type { UsgsHeightSample, HeightPoint } from "../prepare-heights.mjs";
export declare const NAD83_TO_WGS84_ALLOWANCE_METERS: number;
export declare function resolveUsgsHeight(point: HeightPoint, elevation: { value: string | number; resolution: number; rasterId?: unknown; attributes?: { AcquisitionDate?: string } },
  geoid: { geoidModel: string; units: string; geoidHeight: number; error: number; lat: number; lon: number }, maxResolutionMeters?: number): UsgsHeightSample;
export declare function createUsgsSampler(options: { cacheDir: string; fetcher?: typeof fetch; refresh?: boolean; maxResolutionMeters?: number; timeoutMs?: number }): (point: HeightPoint) => Promise<UsgsHeightSample>;
