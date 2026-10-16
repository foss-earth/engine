import type { GoogleHeightSample } from "./heights/google.mjs";
export { DEFAULT_MAX_GEOMETRIC_ERROR_METERS, GoogleUnavailableError } from "./heights/google.mjs";
export declare const HEIGHT_SAMPLE_FORMAT: "foss-earth-height-samples";
export declare const GOOGLE_PROVIDER: "google-photorealistic-3d-tiles";
export declare const USGS_PROVIDER: "usgs-3dep-epqs-geoid18";
export interface HeightPoint { id: string; longitudeDeg: number; latitudeDeg: number }
export interface PreparedHeight {
  meters: number; datum: "WGS84-ellipsoid"; uncertaintyMeters: number; source: string;
}
export interface HeightPreparation {
  provider: typeof GOOGLE_PROVIDER | typeof USGS_PROVIDER; sampledOn: string; longitudeDeg: number; latitudeDeg: number;
  surface: "top of mesh" | "bare earth"; geometricErrorMeters?: number; tileDepth?: number; resolutionMeters?: number; fallbackReason?: string;
}
export interface HeightRecord extends HeightPoint { height: PreparedHeight; preparation: HeightPreparation }
export interface UsgsHeightSample { meters: number; uncertaintyMeters: number; resolutionMeters: number; description: string }
export declare function readGoogleKey(options?: { env?: Record<string, string | undefined>; files?: string[] }): { key: string | null; origin: string | null };
export declare function prepareHeightSamples(points: HeightPoint[], options?: {
  googleKey?: string | null; fetcher?: typeof fetch; cacheDir?: string; refresh?: boolean; fallback?: boolean;
  maxGeometricErrorMeters?: number; concurrency?: number; now?: () => Date;
  onProgress?: (id: string, done: number, total: number, provider: string) => void;
  google?: (point: HeightPoint) => Promise<GoogleHeightSample>;
  usgs?: (point: HeightPoint) => Promise<UsgsHeightSample>;
}): Promise<{ format: typeof HEIGHT_SAMPLE_FORMAT; version: 2; points: HeightRecord[] }>;
