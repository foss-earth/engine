import { DEG_TO_RAD, WGS84_A } from "../camera/cameraMath.js";

/** Center plus two rings. Consumers choose the coverage policy; engine only generates positions. */
export function terrainReadinessSamples(latDeg: number, lonDeg: number, radiusMeters: number) {
  const samples = [{ latDeg, lonDeg }];
  // Great-circle offsets work at the dateline and poles as well as Minneapolis.
  const lat = latDeg * DEG_TO_RAD, lon = lonDeg * DEG_TO_RAD;
  for (const [radius, count] of [[radiusMeters / 2, 8], [radiusMeters, 16]]) {
    if (radius === 0) continue;
    const distance = radius / WGS84_A;
    for (let i = 0; i < count; i++) {
      const bearing = i * 2 * Math.PI / count;
      const nextLat = Math.asin(Math.sin(lat) * Math.cos(distance)
        + Math.cos(lat) * Math.sin(distance) * Math.cos(bearing));
      const nextLon = lon + Math.atan2(Math.sin(bearing) * Math.sin(distance) * Math.cos(lat),
        Math.cos(distance) - Math.sin(lat) * Math.sin(nextLat));
      samples.push({ latDeg: nextLat / DEG_TO_RAD, lonDeg: ((nextLon / DEG_TO_RAD + 540) % 360) - 180 });
    }
  }
  return samples;
}

