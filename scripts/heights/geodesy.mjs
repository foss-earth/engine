/** WGS84 conversions for build-time height preparation. Node only; double precision throughout. */
const A = 6378137;
const F = 1 / 298.257223563;
const E2 = F * (2 - F);
const B = A * (1 - F);
const EP2 = (A * A - B * B) / (B * B);
const RAD = Math.PI / 180;

/** Longitude, latitude and WGS84 ellipsoid height to earth-centred, earth-fixed metres. */
export function geodeticToEcef(longitudeDeg, latitudeDeg, heightMeters) {
  const lon = longitudeDeg * RAD, lat = latitudeDeg * RAD;
  const sinLat = Math.sin(lat), cosLat = Math.cos(lat);
  const n = A / Math.sqrt(1 - E2 * sinLat * sinLat);
  return [(n + heightMeters) * cosLat * Math.cos(lon), (n + heightMeters) * cosLat * Math.sin(lon), (n * (1 - E2) + heightMeters) * sinLat];
}

/** Earth-centred, earth-fixed metres to longitude, latitude and WGS84 ellipsoid height (Bowring, then one refinement). */
export function ecefToGeodetic([x, y, z]) {
  const p = Math.hypot(x, y);
  const theta = Math.atan2(z * A, p * B);
  let lat = Math.atan2(z + EP2 * B * Math.sin(theta) ** 3, p - E2 * A * Math.cos(theta) ** 3);
  for (let i = 0; i < 2; i++) {
    const n = A / Math.sqrt(1 - E2 * Math.sin(lat) ** 2);
    const h = p / Math.cos(lat) - n;
    lat = Math.atan2(z, p * (1 - E2 * n / (n + h)));
  }
  const n = A / Math.sqrt(1 - E2 * Math.sin(lat) ** 2);
  const heightMeters = Math.abs(Math.cos(lat)) > 1e-9 ? p / Math.cos(lat) - n : Math.abs(z) - B;
  return { longitudeDeg: Math.atan2(y, x) / RAD, latitudeDeg: lat / RAD, heightMeters };
}
