#!/usr/bin/env node
/**
 * Build-time height preparation. Never imported by the browser entry points.
 *
 * Google Photorealistic 3D Tiles are the source: the top of the finest geometry Google serves on
 * the vertical through each point. USGS 3DEP with GEOID18 is a fallback, used only for a point
 * Google can't serve, and the reason is recorded with the height.
 */
import { readFileSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createGoogleTilesClient, DEFAULT_MAX_GEOMETRIC_ERROR_METERS, GoogleUnavailableError, sampleGoogleHeight } from './heights/google.mjs';
import { createUsgsSampler } from './heights/usgs.mjs';

export { DEFAULT_MAX_GEOMETRIC_ERROR_METERS, GoogleUnavailableError } from './heights/google.mjs';
export const HEIGHT_SAMPLE_FORMAT = 'foss-earth-height-samples';
export const GOOGLE_PROVIDER = 'google-photorealistic-3d-tiles';
export const USGS_PROVIDER = 'usgs-3dep-epqs-geoid18';
const KEY_NAME = 'GOOGLE_3D_TILES_KEY';
const LEGACY_KEY_NAME = 'FOSS_EARTH_GOOGLE_KEY';
const round = value => Math.round(value * 1000) / 1000;
const ceilCentimetre = value => Math.ceil(value * 100) / 100;

/**
 * The Google key: environment before files, preferring the canonical name within each source.
 * A canonical file value beats a legacy value from any file. Only these named variables are
 * read. The result says where it came from, never what it is.
 */
export function readGoogleKey({ env = process.env, files = [] } = {}) {
  for (const name of [KEY_NAME, LEGACY_KEY_NAME]) {
    if (env[name]?.trim()) return { key: env[name].trim(), origin: 'environment' };
  }
  let legacy = null;
  for (const file of files) {
    let text;
    try { text = readFileSync(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    for (const name of [KEY_NAME, LEGACY_KEY_NAME]) {
      const match = new RegExp(`^[ \\t]*(?:export[ \\t]+)?${name}[ \\t]*=[ \\t]*(?:"([^"\\r\\n]*)"|'([^'\\r\\n]*)'|([^#\\r\\n]*))`, 'm').exec(text);
      const value = (match?.[1] ?? match?.[2] ?? match?.[3] ?? '').trim();
      if (!value) continue;
      if (name === KEY_NAME) return { key: value, origin: file };
      legacy ??= { key: value, origin: file };
    }
  }
  return legacy ?? { key: null, origin: null };
}

function checkPoints(points) {
  if (!Array.isArray(points) || !points.length) throw new Error('Expected a nonempty list of points.');
  const ids = new Set();
  for (const point of points) {
    if (typeof point?.id !== 'string' || !point.id || ids.has(point.id)) throw new Error('Every point needs a unique id.');
    ids.add(point.id);
    if (!Number.isFinite(point.longitudeDeg) || !Number.isFinite(point.latitudeDeg) || Math.abs(point.latitudeDeg) > 90 || Math.abs(point.longitudeDeg) > 180) throw new Error(`${point.id}: invalid coordinate.`);
  }
}

function googleRecord(point, sample, sampledOn) {
  const copyright = sample.copyright ? ` Data ${sample.copyright}.` : '';
  return {
    id: point.id, longitudeDeg: point.longitudeDeg, latitudeDeg: point.latitudeDeg,
    height: {
      meters: round(sample.heightMeters), datum: 'WGS84-ellipsoid', uncertaintyMeters: ceilCentimetre(sample.geometricErrorMeters),
      source: `Build-time Google Photorealistic 3D Tiles, ${sampledOn}: top of the finest geometry on the vertical through the capture coordinate (leaf geometric error ${round(sample.geometricErrorMeters)} m). WGS84 ellipsoid from Google's earth-centred coordinates; no datum conversion.${copyright} The orb's ground reference: the surface there, or a roof where the coordinate is on a building; not a measured camera height.`,
    },
    preparation: { provider: GOOGLE_PROVIDER, sampledOn, longitudeDeg: point.longitudeDeg, latitudeDeg: point.latitudeDeg, surface: 'top of mesh', geometricErrorMeters: round(sample.geometricErrorMeters), tileDepth: sample.tileDepth },
  };
}

function usgsRecord(point, sample, sampledOn, fallbackReason) {
  return {
    id: point.id, longitudeDeg: point.longitudeDeg, latitudeDeg: point.latitudeDeg,
    height: {
      meters: sample.meters, datum: 'WGS84-ellipsoid', uncertaintyMeters: sample.uncertaintyMeters,
      source: `Build-time fallback, ${sampledOn}, because Google was unavailable (${fallbackReason}): ${sample.description}. Bare earth, not a measured camera height.`,
    },
    preparation: { provider: USGS_PROVIDER, sampledOn, longitudeDeg: point.longitudeDeg, latitudeDeg: point.latitudeDeg, surface: 'bare earth', resolutionMeters: sample.resolutionMeters, fallbackReason },
  };
}

/**
 * Heights for points `{ id, longitudeDeg, latitudeDeg }`. All succeed or the call throws; a
 * partial result is never returned. `fallback: false` refuses USGS and fails instead.
 */
export async function prepareHeightSamples(points, options = {}) {
  checkPoints(points);
  const {
    googleKey = null, fetcher = fetch, cacheDir, refresh = false, fallback = true,
    maxGeometricErrorMeters = DEFAULT_MAX_GEOMETRIC_ERROR_METERS, concurrency = 4,
    now = () => new Date(), onProgress = () => {}, google: injectedGoogle, usgs: injectedUsgs,
  } = options;
  const sampledOn = now().toISOString().slice(0, 10);
  let client = null, clientFailure = null;
  if (!injectedGoogle) {
    try { client = createGoogleTilesClient({ apiKey: googleKey, fetcher }); }
    catch (error) { if (error instanceof GoogleUnavailableError) clientFailure = error; else throw error; }
  }
  const google = injectedGoogle ?? (point => {
    if (clientFailure) throw clientFailure;
    return sampleGoogleHeight(client, point, { maxGeometricErrorMeters });
  });
  let usgs = injectedUsgs ?? null;
  const results = new Array(points.length);
  let next = 0, done = 0;
  async function worker() {
    while (next < points.length) {
      const index = next++;
      const point = points[index];
      try {
        results[index] = googleRecord(point, await google(point), sampledOn);
      } catch (error) {
        if (!(error instanceof GoogleUnavailableError)) throw error;
        const reason = `${error.kind}: ${error.message}`;
        if (!fallback) throw new Error(`${point.id}: Google unavailable and fallback is off (${reason})`);
        usgs ??= createUsgsSampler({ cacheDir, fetcher, refresh });
        results[index] = usgsRecord(point, await usgs(point), sampledOn, reason);
      }
      onProgress(point.id, ++done, points.length, results[index].preparation.provider);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, points.length) }, worker));
  return { format: HEIGHT_SAMPLE_FORMAT, version: 2, points: results };
}

async function main() {
  const args = process.argv.slice(2), values = {};
  for (let i = 0; i < args.length; i++) {
    const name = args[i].slice(2);
    if (name === 'no-fallback') { values.noFallback = true; continue; }
    if (!['input', 'output', 'cache', 'max-geometric-error'].includes(name) || !args[i + 1]) {
      throw new Error('Usage: foss-earth-prepare-heights --input points.json --output heights.json --cache build/elevation-cache [--max-geometric-error 4] [--no-fallback]\nReads GOOGLE_3D_TILES_KEY from the environment (FOSS_EARTH_GOOGLE_KEY is a legacy fallback).');
    }
    values[name] = args[++i];
  }
  if (!values.input || !values.output || !values.cache) throw new Error('Require --input, --output and --cache.');
  const points = JSON.parse(await readFile(values.input, 'utf8'));
  const { key } = readGoogleKey();
  const samples = await prepareHeightSamples(points, {
    googleKey: key, cacheDir: values.cache, fallback: !values.noFallback,
    maxGeometricErrorMeters: values['max-geometric-error'] ? Number(values['max-geometric-error']) : undefined,
    onProgress: (id, n, total, provider) => console.log(`${n}/${total}: ${id} (${provider})`),
  });
  const temporary = `${values.output}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(samples, null, 2)}\n`);
  await rename(temporary, path.resolve(values.output));
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
