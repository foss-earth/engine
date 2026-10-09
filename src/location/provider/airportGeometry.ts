import type { AirportPoint } from "./airportTypes.js";
const RAD = Math.PI / 180;
const EARTH_RADIUS = 6371008.8;
export function bearing(from: AirportPoint, to: AirportPoint): number {
  const delta = (to.lonDeg - from.lonDeg) * RAD;
  const a = from.latDeg * RAD, b = to.latDeg * RAD;
  return (Math.atan2(Math.sin(delta) * Math.cos(b), Math.cos(a) * Math.sin(b)
    - Math.sin(a) * Math.cos(b) * Math.cos(delta)) / RAD + 360) % 360;
}
export function distance(from: AirportPoint, to: AirportPoint): number {
  const a = Math.sin((to.latDeg - from.latDeg) * RAD / 2) ** 2
    + Math.cos(from.latDeg * RAD) * Math.cos(to.latDeg * RAD) * Math.sin((to.lonDeg - from.lonDeg) * RAD / 2) ** 2;
  return 2 * EARTH_RADIUS * Math.asin(Math.sqrt(Math.min(1, a)));
}
