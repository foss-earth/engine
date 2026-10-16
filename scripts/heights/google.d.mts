export declare const GOOGLE_3D_TILES_ROOT: string;
export declare const DEFAULT_MAX_GEOMETRIC_ERROR_METERS: number;
export type GoogleUnavailableKind = "no-key" | "auth" | "http" | "network" | "budget" | "format" | "coarse" | "no-coverage";
export declare class GoogleUnavailableError extends Error {
  constructor(kind: GoogleUnavailableKind, message: string);
  kind: GoogleUnavailableKind;
}
export type Vec3 = [number, number, number];
export interface TileTriangles { positions: Float64Array; indices: ArrayLike<number> }
export declare function redactGoogleUrl(href: string): string;
export declare function segmentIntersectsVolume(volume: { box?: number[]; sphere?: number[] } | undefined, p0: Vec3, p1: Vec3): boolean;
export declare function parseGlb(bytes: Uint8Array): { json: Record<string, unknown>; bin: Uint8Array | null };
export declare function trianglesOfGlb(bytes: Uint8Array, tileTransform?: number[]): Promise<{ triangles: TileTriangles[]; copyright: string | null }>;
export declare function firstHit(triangles: TileTriangles[], origin: Vec3, direction: Vec3, maxDistance: number): number | null;
export interface GoogleTilesClient {
  rootUrl: string;
  tileset(href: string, counter?: { count: number }): Promise<{ root: unknown }>;
  triangles(href: string, transform: number[], counter?: { count: number }): Promise<{ triangles: TileTriangles[]; copyright: string | null }>;
}
export declare function createGoogleTilesClient(options: {
  apiKey: string | null; fetcher?: typeof fetch; concurrency?: number; timeoutMs?: number; retries?: number; rootUrl?: string;
}): GoogleTilesClient;
export interface GoogleHeightSample { heightMeters: number; geometricErrorMeters: number; tileDepth: number; copyright: string | null; requests: number }
export declare function sampleGoogleHeight(client: GoogleTilesClient, point: { longitudeDeg: number; latitudeDeg: number }, options?: { maxGeometricErrorMeters?: number }): Promise<GoogleHeightSample>;
