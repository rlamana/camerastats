import type { PhotoMetadata } from './metadata.js';

/** One row of a statistic: a grouped value and how often it was shot. */
export interface StatEntry {
  /** Numeric value after bucketing, useful for sorting or plotting. */
  value: number;
  /** Human-readable form, e.g. `35mm` or `f/2.8`. */
  label: string;
  /** Number of photos in this bucket. */
  count: number;
  /** Share of the photos that reported this statistic, 0–100. */
  percentage: number;
}

/** A complete statistic (focal length, aperture, ...) over the scanned set. */
export interface Dimension {
  id: string;
  title: string;
  /** Photos that reported a usable value for this statistic. */
  samples: number;
  entries: StatEntry[];
}

export type SortMode = 'count' | 'value';

/** How a statistic is derived from one photo's metadata. */
export interface DimensionSpec {
  id: string;
  title: string;
  /** Pull the raw number out of the metadata, or `undefined` if absent. */
  read: (metadata: PhotoMetadata) => number | undefined;
  /** Collapse near-identical values into one bucket. */
  bucket: (value: number) => number;
  /** Render a bucketed value for display. */
  format: (value: number) => string;
}

/** Round to `decimals` places without float dust (`1.05 -> 1.1`). */
function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

/** `4` not `4.0`, but `5.6` stays `5.6`. */
function trimNumber(value: number): string {
  return String(round(value, 1));
}

/**
 * Focal lengths cluster tightly (a "50mm" lens reports 50.0, 49.9, 50.1
 * depending on the body), so whole millimetres is the right bucket — except
 * for short compact and phone lenses where 1mm is a huge relative step.
 */
export const FOCAL_LENGTH_DIMENSION: DimensionSpec = {
  id: 'focalLength',
  title: 'Focal length',
  read: (metadata) => metadata.focalLength,
  bucket: (value) => (value >= 10 ? Math.round(value) : round(value, 1)),
  format: (value) => `${trimNumber(value)}mm`,
};

/** Same statistic, but using the camera's 35mm-equivalent figure when present. */
export const FOCAL_LENGTH_35MM_DIMENSION: DimensionSpec = {
  ...FOCAL_LENGTH_DIMENSION,
  id: 'focalLength35mm',
  title: 'Focal length (35mm equivalent)',
  read: (metadata) => metadata.focalLength35mm ?? metadata.focalLength,
};

/** f-numbers are already a coarse scale; one decimal keeps f/5.6 distinct from f/5.0. */
export const APERTURE_DIMENSION: DimensionSpec = {
  id: 'aperture',
  title: 'Aperture',
  read: (metadata) => metadata.fNumber,
  bucket: (value) => round(value, 1),
  format: (value) => `f/${trimNumber(value)}`,
};

/** The bucket this photo falls into for `spec`, or `undefined` if it has no value. */
export function bucketValue(spec: DimensionSpec, metadata: PhotoMetadata): number | undefined {
  const raw = spec.read(metadata);
  if (raw === undefined || !Number.isFinite(raw) || raw <= 0) return undefined;
  return spec.bucket(raw);
}

/** Whether a photo reports this statistic at all, without counting it. */
export function hasValue(spec: DimensionSpec, metadata: PhotoMetadata): boolean {
  return bucketValue(spec, metadata) !== undefined;
}

/** Accumulates one statistic across a stream of photos. */
export class DimensionCounter {
  private readonly counts = new Map<number, number>();
  private total = 0;

  constructor(private readonly spec: DimensionSpec) {}

  add(metadata: PhotoMetadata): boolean {
    const bucketed = bucketValue(this.spec, metadata);
    if (bucketed === undefined) return false;
    this.counts.set(bucketed, (this.counts.get(bucketed) ?? 0) + 1);
    this.total += 1;
    return true;
  }

  /** Snapshot the tally, sorted by frequency (or by value when asked). */
  result(sort: SortMode = 'count'): Dimension {
    const entries: StatEntry[] = [...this.counts.entries()].map(([value, count]) => ({
      value,
      label: this.spec.format(value),
      count,
      percentage: this.total === 0 ? 0 : (count / this.total) * 100,
    }));

    entries.sort((a, b) =>
      sort === 'value' ? a.value - b.value : b.count - a.count || a.value - b.value,
    );

    return { id: this.spec.id, title: this.spec.title, samples: this.total, entries };
  }
}
