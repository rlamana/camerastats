import { identifyCamera, type CameraIdentity } from './camera.js';
import { readPhotoMetadata } from './metadata.js';
import { walkImages, type ScanOptions } from './scanner.js';
import {
  DimensionCounter,
  hasValue,
  type Dimension,
  type DimensionSpec,
  type SortMode,
} from './stats.js';

export interface AnalyzeOptions {
  /** Folder to scan. */
  root: string;
  /** Statistics to accumulate. */
  dimensions: readonly DimensionSpec[];
  /** How to order the rows of each statistic. */
  sort?: SortMode;
  /** Also break every statistic down per camera. */
  groupByCamera?: boolean;
  /**
   * Restrict the report to cameras whose display name satisfies this predicate.
   * Non-matching photos are excluded from the per-camera *and* the combined
   * figures, so every number in the report describes the same set of photos.
   */
  cameraFilter?: (name: string) => boolean;
  /** Files parsed in parallel. EXIF reading is I/O bound, so this is worth raising. */
  concurrency?: number;
  scan: Omit<ScanOptions, 'onError'>;
  /** Invoked as files complete, for progress reporting. */
  onProgress?: (processed: number) => void;
}

export interface AnalysisTotals {
  /** Candidate image files found by the walk. */
  files: number;
  /** Files that yielded at least one of the requested statistics. */
  withStats: number;
  /** Files parsed successfully but missing every requested tag. */
  withoutStats: number;
  /** Files whose metadata could not be read at all. */
  unreadable: number;
  /** Files dropped because their camera did not match `cameraFilter`. */
  filtered: number;
}

/** One camera's slice of the report. */
export interface CameraGroup {
  camera: CameraIdentity;
  /** Photos from this camera that reported at least one statistic. */
  photos: number;
  /** Share of all counted photos that came from this camera, 0–100. */
  percentage: number;
  dimensions: Dimension[];
}

export interface AnalysisResult {
  root: string;
  totals: AnalysisTotals;
  /** Statistics across every counted photo, whatever camera took it. */
  dimensions: Dimension[];
  /** Per-camera breakdown, most-used camera first. Empty unless grouping is on. */
  cameras: CameraGroup[];
  /** Directories or files that could not be read, capped to keep output sane. */
  errors: { path: string; message: string }[];
  durationMs: number;
}

const MAX_REPORTED_ERRORS = 20;

/** Mutable per-camera accumulator, collapsed into a `CameraGroup` at the end. */
interface CameraBucket {
  camera: CameraIdentity;
  photos: number;
  counters: DimensionCounter[];
}

/** Walk `root`, read EXIF from every image found, and tally the statistics. */
export async function analyze(options: AnalyzeOptions): Promise<AnalysisResult> {
  const startedAt = performance.now();
  const concurrency = Math.max(1, options.concurrency ?? 16);
  const sort = options.sort ?? 'count';

  const combined = options.dimensions.map((spec) => new DimensionCounter(spec));
  const buckets = new Map<string, CameraBucket>();

  const totals: AnalysisTotals = {
    files: 0,
    withStats: 0,
    withoutStats: 0,
    unreadable: 0,
    filtered: 0,
  };

  const errors: { path: string; message: string }[] = [];
  const recordError = (path: string, error: NodeJS.ErrnoException): void => {
    if (errors.length < MAX_REPORTED_ERRORS) errors.push({ path, message: error.message });
  };

  const files = walkImages(options.root, { ...options.scan, onError: recordError });
  const iterator = files[Symbol.asyncIterator]();

  // A fixed pool of workers pulling from the walk. Async generators serialize
  // concurrent `next()` calls for us, so no extra locking is needed.
  const workers = Array.from({ length: concurrency }, async () => {
    for (;;) {
      const next = await iterator.next();
      if (next.done) return;

      totals.files += 1;
      const filePath = next.value;

      try {
        const metadata = await readPhotoMetadata(filePath);
        if (!metadata) {
          totals.unreadable += 1;
          continue;
        }

        // Establish that the file has something to report *before* applying the
        // camera filter, so a screenshot with no EXIF is counted as "no stats"
        // rather than inflating "photos from other cameras".
        if (!options.dimensions.some((spec) => hasValue(spec, metadata))) {
          // It does not join a camera group either — otherwise every EXIF-less
          // screenshot would pile up under "Unknown camera" and imply a camera
          // that never existed.
          totals.withoutStats += 1;
          continue;
        }

        const camera = identifyCamera(metadata);
        if (options.cameraFilter && !options.cameraFilter(camera.name)) {
          totals.filtered += 1;
          continue;
        }

        totals.withStats += 1;
        for (const counter of combined) counter.add(metadata);
        if (!options.groupByCamera) continue;

        let bucket = buckets.get(camera.name);
        if (!bucket) {
          bucket = {
            camera,
            photos: 0,
            counters: options.dimensions.map((spec) => new DimensionCounter(spec)),
          };
          buckets.set(camera.name, bucket);
        }
        bucket.photos += 1;
        for (const counter of bucket.counters) counter.add(metadata);
      } catch (error) {
        totals.unreadable += 1;
        recordError(filePath, error as NodeJS.ErrnoException);
      } finally {
        options.onProgress?.(totals.files);
      }
    }
  });

  await Promise.all(workers);

  const cameras: CameraGroup[] = [...buckets.values()]
    .map((bucket) => ({
      camera: bucket.camera,
      photos: bucket.photos,
      percentage: totals.withStats === 0 ? 0 : (bucket.photos / totals.withStats) * 100,
      dimensions: bucket.counters.map((counter) => counter.result(sort)),
    }))
    .sort((a, b) => b.photos - a.photos || a.camera.name.localeCompare(b.camera.name));

  return {
    root: options.root,
    totals,
    dimensions: combined.map((counter) => counter.result(sort)),
    cameras,
    errors,
    durationMs: performance.now() - startedAt,
  };
}
