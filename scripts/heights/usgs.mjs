/**
 * The fallback height source: USGS 3DEP bare-earth elevation with NOAA GEOID18, used only when
 * Google can't serve a point. Public data; raw responses are cached on disk for offline rebuilds.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const finite = value => typeof value === 'number' && Number.isFinite(value);
const round = value => Math.round(value * 1000) / 1000;
/** NAD83(2011) to WGS84 is taken as a null transformation; this allowance covers that approximation. */
export const NAD83_TO_WGS84_ALLOWANCE_METERS = 5;

/** EPQS reports NAVD88 in CONUS. GEOID18 converts it to the NAD83(2011) ellipsoid. NAD83 to WGS84
 * uses an explicitly approximate null transformation with a 5 m allowance, never an unlabelled
 * orthometric height. This is bare-earth terrain, not a survey of a photograph's camera or floor. */
export function resolveUsgsHeight(point, elevation, geoid, maxResolutionMeters = 1) {
  if (!point || typeof point.id !== 'string' || !point.id || !finite(point.longitudeDeg) || !finite(point.latitudeDeg)
    || point.longitudeDeg < -125 || point.longitudeDeg > -66 || point.latitudeDeg < 24 || point.latitudeDeg > 50) {
    throw new Error('USGS/GEOID18 preparation requires an id and a coordinate in CONUS.');
  }
  if (!finite(maxResolutionMeters) || maxResolutionMeters <= 0) throw new Error('Invalid elevation resolution limit.');
  const orthometric = typeof elevation?.value === 'string' && elevation.value.trim() ? Number(elevation.value) : elevation?.value;
  if (!finite(orthometric) || orthometric < -500 || orthometric > 9000 || !finite(elevation.resolution)
    || elevation.resolution <= 0 || elevation.resolution > maxResolutionMeters) {
    throw new Error(`${point.id}: USGS elevation is missing or coarser than ${maxResolutionMeters} m.`);
  }
  if (geoid?.geoidModel !== 'GEOID18' || geoid.units !== 'm' || !finite(geoid.geoidHeight)
    || Math.abs(geoid.geoidHeight) > 150 || !finite(geoid.error) || geoid.error < 0
    || Math.abs(geoid.lat - point.latitudeDeg) > 1e-7 || Math.abs(geoid.lon - point.longitudeDeg) > 1e-7) {
    throw new Error(`${point.id}: invalid GEOID18 response; no height was written.`);
  }
  return {
    meters: round(orthometric + geoid.geoidHeight),
    uncertaintyMeters: round(NAD83_TO_WGS84_ALLOWANCE_METERS + geoid.error + elevation.resolution),
    resolutionMeters: elevation.resolution,
    description: `USGS 3DEP EPQS ${elevation.resolution} m bare-earth terrain (raster ${elevation.rasterId}, acquired ${elevation.attributes?.AcquisitionDate ?? 'date unavailable'}): NAVD88 ${orthometric} m + NOAA GEOID18 ${geoid.geoidHeight} m = NAD83(2011) ellipsoid, taken as WGS84 by an approximate null transformation within ${NAD83_TO_WGS84_ALLOWANCE_METERS} m`,
  };
}

/** A USGS sampler over a disk cache of raw public responses. */
export function createUsgsSampler({ cacheDir, fetcher = fetch, refresh = false, maxResolutionMeters = 1, timeoutMs = 30000 } = {}) {
  if (!cacheDir) throw new Error('A build cache directory is required for USGS responses.');
  async function json(url) {
    await mkdir(cacheDir, { recursive: true });
    const file = path.join(cacheDir, `${createHash('sha256').update(url).digest('hex')}.json`);
    if (!refresh) {
      try {
        const cached = JSON.parse(await readFile(file, 'utf8'));
        if (cached.url !== url || !cached.response) throw new Error(`Invalid elevation cache: ${file}`);
        return cached.response;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    let last;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetcher(url, { signal: AbortSignal.timeout(timeoutMs) });
        if (!response.ok) throw new Error(`Height service returned HTTP ${response.status}.`);
        const value = await response.json();
        const temporary = `${file}.${process.pid}.tmp`;
        await writeFile(temporary, `${JSON.stringify({ url, response: value }, null, 2)}\n`);
        await rename(temporary, file);
        return value;
      } catch (error) { last = error; }
    }
    throw last;
  }
  return async function sampleUsgsHeight(point) {
    // Refuse a bad coordinate before sending it to either public service.
    resolveUsgsHeight(point, { value: '0', resolution: maxResolutionMeters }, { geoidModel: 'GEOID18', units: 'm', geoidHeight: 0, error: 0, lat: point.latitudeDeg, lon: point.longitudeDeg }, maxResolutionMeters);
    const elevationUrl = new URL('https://epqs.nationalmap.gov/v1/json');
    elevationUrl.search = new URLSearchParams({ x: String(point.longitudeDeg), y: String(point.latitudeDeg), units: 'Meters', wkid: '4326', includeDate: 'true' });
    const geoidUrl = new URL('https://geodesy.noaa.gov/api/geoid/ght');
    geoidUrl.search = new URLSearchParams({ lat: String(point.latitudeDeg), lon: String(point.longitudeDeg), model: '14' });
    const elevation = await json(elevationUrl.href);
    if (!finite(elevation.resolution) || elevation.resolution > maxResolutionMeters) throw new Error(`${point.id}: best EPQS coverage is ${elevation.resolution} m; requires ${maxResolutionMeters} m.`);
    return resolveUsgsHeight(point, elevation, await json(geoidUrl.href), maxResolutionMeters);
  };
}
