/**
 * Tile-count distributions on the detail axis. Binning and text live here so
 * the rail, the controller and both renderers share one contract. The scalar
 * loaded target stays beside this; a distribution is never inferred from it.
 */

import {
  detailPosition,
  formatDetailValue,
  type DetailDistribution,
  type DetailDistributionSample,
  type DetailKind,
} from "./mapDetailPolicy.js";

export interface DetailDistributionInput {
  status: DetailDistribution["status"];
  kind: DetailKind;
  sourceKey: string;
  generation: number;
  samples?: readonly DetailDistributionSample[];
  tileCount?: number;
  unknownCount?: number;
  incomplete?: boolean;
  reason?: string;
}

function sampleToken(value: number): string {
  if (value === Infinity) return "inf";
  if (value === -Infinity) return "-inf";
  if (Number.isNaN(value)) return "nan";
  return String(Object.is(value, -0) ? 0 : value);
}

function combineSamples(samples: readonly DetailDistributionSample[]): DetailDistributionSample[] {
  const counts = new Map<number, number>();
  for (const sample of samples) {
    if (!Number.isInteger(sample.count) || sample.count <= 0) continue;
    if (Number.isNaN(sample.value)) continue;
    const value = Object.is(sample.value, -0) ? 0 : sample.value;
    counts.set(value, (counts.get(value) ?? 0) + sample.count);
  }
  return [...counts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([value, count]) => ({ value, count }));
}

function revisionOf(distribution: Omit<DetailDistribution, "revision">): string {
  const samples = distribution.samples.map(sample => `${sampleToken(sample.value)}:${sample.count}`).join(",");
  return [
    distribution.status,
    distribution.kind,
    distribution.sourceKey,
    distribution.generation,
    distribution.tileCount,
    distribution.unknownCount,
    distribution.incomplete ? 1 : 0,
    distribution.reason ?? "",
    samples,
  ].join("|");
}

/** An immutable snapshot. Equal populations share a revision. */
export function createDetailDistribution(input: DetailDistributionInput): DetailDistribution {
  const unavailable = input.status === "unavailable";
  const samples = unavailable ? [] : combineSamples(input.samples ?? []);
  const unknownCount = unavailable ? 0 : Math.max(0, input.unknownCount ?? 0);
  const counted = samples.reduce((sum, sample) => sum + sample.count, 0);
  const tileCount = unavailable ? 0 : input.tileCount ?? counted + unknownCount;
  const incomplete = unavailable ? false : input.incomplete === true;
  const status = unavailable ? "unavailable" : input.status === "empty" || (tileCount === 0 && unknownCount === 0 && !incomplete) ? "empty" : "measured";
  const measured = status === "measured";
  const body = {
    status,
    kind: input.kind,
    sourceKey: input.sourceKey,
    generation: input.generation,
    samples: measured ? samples : [],
    tileCount: measured ? tileCount : 0,
    unknownCount: measured ? unknownCount : 0,
    incomplete: measured && incomplete,
    ...(input.reason !== undefined && status === "unavailable" ? { reason: input.reason } : {}),
  } satisfies Omit<DetailDistribution, "revision">;
  return { ...body, revision: revisionOf(body) };
}

export function unavailableDetailDistribution(sourceKey: string, kind: DetailKind, generation: number, reason: string): DetailDistribution {
  return createDetailDistribution({ status: "unavailable", kind, sourceKey, generation, reason });
}

/** A detached copy, so a later edit of the runtime's arrays cannot change the controller. */
export function copyDetailDistribution(distribution: DetailDistribution | null | undefined): DetailDistribution | null {
  if (!distribution) return null;
  return createDetailDistribution(distribution);
}

/**
 * The snapshot the rail may draw for this source. A missing or mismatched
 * snapshot is unavailable: the scalar must not become a single bar.
 */
export function deliveryDistribution(key: string, kind: DetailKind, distribution: DetailDistribution | null | undefined): DetailDistribution {
  if (!distribution || distribution.sourceKey !== key || distribution.kind !== kind) {
    return unavailableDetailDistribution(
      key,
      kind,
      distribution?.generation ?? 0,
      distribution ? "Loaded detail distribution does not match this map." : "Loaded detail distribution is not available.",
    );
  }
  return copyDetailDistribution(distribution)!;
}

export interface GoogleTileMeasurement {
  inView: boolean;
  /** Native camera error in pixels, before focus or anchor overrides. */
  error: number;
  drawable: boolean;
}

/** One count per drawable, in-view tile. Invalid errors are unknown; infinities stay measurements. */
export function createGoogleDetailDistribution(generation: number, tiles: readonly GoogleTileMeasurement[]): DetailDistribution {
  const counts = new Map<number, number>();
  let unknownCount = 0;
  let measured = 0;
  for (const tile of tiles) {
    if (!tile.inView || !tile.drawable) continue;
    const error = tile.error;
    if (Number.isNaN(error) || error < 0 || (error !== Infinity && !Number.isFinite(error))) {
      unknownCount += 1;
      continue;
    }
    measured += 1;
    const value = Object.is(error, -0) ? 0 : error;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return createDetailDistribution({
    status: measured + unknownCount === 0 ? "empty" : "measured",
    kind: "google",
    sourceKey: "google",
    generation,
    samples: [...counts.entries()].map(([value, count]) => ({ value, count })),
    tileCount: measured + unknownCount,
    unknownCount,
    incomplete: false,
  });
}

/** About 3 CSS px per bar, 13 bars on the 41 px rail, and never more than 64. */
export function detailBinCount(widthPx: number): number {
  if (!(widthPx > 0)) return 13;
  return Math.min(64, Math.max(1, Math.floor(widthPx / 3)));
}

export interface DetailDistributionBar {
  index: number;
  count: number;
  /** Tiles in this bar that lie outside the selectable range. */
  overflow: number;
  overflowSide: "finer" | "coarser" | null;
  x: number;
  width: number;
  y: number;
  height: number;
}

export interface DetailBinLayout {
  binCount: number;
  ceiling: number;
  finerOverflow: number;
  coarserOverflow: number;
  bars: readonly DetailDistributionBar[];
}

const FULL_BAR_PX = 28;
const BAR_CENTER_Y = 14;

export function layoutDetailDistribution(options: {
  kind: DetailKind;
  /** Selectable endpoints in the policy's own units. */
  finer: number;
  coarser: number;
  widthPx: number;
  distribution: DetailDistribution;
}): DetailBinLayout {
  const binCount = detailBinCount(options.widthPx);
  const counts = new Array<number>(binCount).fill(0);
  const overflow = new Array<number>(binCount).fill(0);
  const sides: Array<"finer" | "coarser" | null> = new Array(binCount).fill(null);
  let finerOverflow = 0;
  let coarserOverflow = 0;
  const finerPos = detailPosition(options.kind, options.finer);
  const coarserPos = detailPosition(options.kind, options.coarser);
  const last = binCount - 1;
  const equal = Math.abs(coarserPos - finerPos) < 1e-9;
  const span = coarserPos - finerPos;
  const place = (value: number, count: number): void => {
    const position = detailPosition(options.kind, value);
    let index = 0;
    let side: "finer" | "coarser" | null = null;
    if (!Number.isFinite(position) && position !== Infinity && position !== -Infinity) return;
    if (equal) {
      if (position < finerPos) { index = 0; side = "finer"; }
      else if (position > finerPos) { index = last; side = "coarser"; }
      else index = Math.floor(last / 2);
    } else if (position < finerPos - 1e-9) { index = 0; side = "finer"; }
    else if (position > coarserPos + 1e-9) { index = last; side = "coarser"; }
    else index = Math.min(last, Math.floor((position - finerPos) / (span / binCount)));
    counts[index] += count;
    if (side) {
      overflow[index] += count;
      sides[index] = sides[index] === null || sides[index] === side ? side : sides[index];
      if (side === "finer") finerOverflow += count;
      else coarserOverflow += count;
    }
  };
  if (options.distribution.status === "measured") {
    for (const sample of options.distribution.samples) place(sample.value, sample.count);
  }
  const tallest = counts.reduce((max, count) => Math.max(max, count), 0);
  const ceiling = Math.max(1, tallest);
  const slot = options.widthPx / binCount;
  const gap = slot > 2 ? 1 : 0;
  const width = Math.max(0, slot - gap);
  const bars = counts.map((count, index): DetailDistributionBar => {
    const height = count === 0 || ceiling <= 0 ? 0 : FULL_BAR_PX * count / ceiling;
    return {
      index, count, overflow: overflow[index], overflowSide: sides[index],
      x: index * slot, width, y: BAR_CENTER_Y - height / 2, height,
    };
  });
  return { binCount, ceiling, finerOverflow, coarserOverflow, bars };
}

function extentText(kind: DetailKind, samples: readonly DetailDistributionSample[]): string | null {
  const finite = samples.filter(sample => Number.isFinite(sample.value)).map(sample => sample.value);
  if (finite.length === 0) {
    if (samples.some(sample => sample.value === Infinity || sample.value === -Infinity)) return "Measured beyond the selectable ends.";
    return null;
  }
  const low = Math.min(...finite);
  const high = Math.max(...finite);
  return low === high
    ? `Measured at ${formatDetailValue(kind, low)}.`
    : `Measured from ${formatDetailValue(kind, low)} to ${formatDetailValue(kind, high)}.`;
}

/** The tooltip and accessible value. It does not announce every streaming change by itself. */
export function describeLoadedTiles(
  kind: DetailKind,
  distribution: DetailDistribution,
  bins: Pick<DetailBinLayout, "ceiling" | "finerOverflow" | "coarserOverflow">,
): string {
  if (distribution.status === "unavailable") return distribution.reason ?? "Loaded detail distribution is not available.";
  if (distribution.status === "empty") return kind === "raster" ? "No visible imagery tiles." : "No visible geometry tiles.";
  const noun = distribution.tileCount === 1
    ? (kind === "raster" ? "visible imagery tile" : "visible geometry tile")
    : (kind === "raster" ? "visible imagery tiles" : "visible geometry tiles");
  const how = kind === "raster" ? "detail estimated per tile" : "screen-space error per tile";
  const sentences = [`${distribution.tileCount} ${noun}; ${how}.`];
  if (bins.finerOverflow > 0) sentences.push(`${bins.finerOverflow} finer than the selectable range.`);
  if (bins.coarserOverflow > 0) sentences.push(`${bins.coarserOverflow} coarser than the selectable range.`);
  if (distribution.unknownCount > 0) sentences.push(`${distribution.unknownCount} without a usable measurement.`);
  if (distribution.incomplete) sentences.push(kind === "raster" ? "Some of the view has no bound imagery." : "Coverage is incomplete.");
  sentences.push(`Bar scale: ${bins.ceiling} ${bins.ceiling === 1 ? "tile" : "tiles"}.`);
  const extent = extentText(kind, distribution.samples);
  if (extent) sentences.push(extent);
  return sentences.join(" ");
}
