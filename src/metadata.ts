import exifr from 'exifr';

/**
 * exifr ships a CommonJS build for Node, so the `Exifr` class is only reachable
 * through the default export — a named import type-checks but fails at runtime.
 * Its constructor is also absent from exifr's `.d.ts`, hence the explicit shape.
 */
const ExifrReader = exifr.Exifr as unknown as new (options?: unknown) => {
  read(input: string): Promise<void>;
  parse(): Promise<Record<string, unknown> | undefined>;
  file?: { close?: () => Promise<void> };
};

/** The subset of EXIF we care about, already coerced to plain numbers. */
export interface PhotoMetadata {
  /** Physical focal length in millimetres. */
  focalLength?: number;
  /** Focal length in 35mm-equivalent millimetres, when the camera recorded it. */
  focalLength35mm?: number;
  /** Aperture as an f-number (2.8 means f/2.8). */
  fNumber?: number;
  /** EXIF `Make`, verbatim. Normalized for display by `identifyCamera`. */
  make?: string;
  /** EXIF `Model`, verbatim. Normalized for display by `identifyCamera`. */
  model?: string;
}

/**
 * Only the TIFF/EXIF block is decoded — no GPS, thumbnail, XMP, IPTC or ICC.
 * (IFD0 comes along regardless; exifr has to walk it to reach the EXIF pointer.)
 *
 * We deliberately do not use exifr's `pick`, even though it would be slightly
 * cheaper: `pick` makes exifr return `undefined` both when a file has no EXIF
 * at all and when it has EXIF without the picked tags. Decoding the whole EXIF
 * block keeps those two cases distinguishable, which is what lets the report
 * say "no aperture recorded" instead of lumping the file in with corrupt ones.
 */
const EXIFR_OPTIONS = {
  tiff: true,
  exif: true,
  gps: false,
  interop: false,
  thumbnail: false,
  jfif: false,
  iptc: false,
  xmp: false,
  icc: false,
  translateValues: true,
  reviveValues: true,
  mergeOutput: true,
  // Read the file in chunks and stop as soon as the EXIF block is satisfied.
  // On a 60 MB RAW this is the difference between kilobytes and the whole file.
  chunked: true,
};

/**
 * Read focal length, aperture and camera identity from one image.
 *
 * Returns `undefined` when the file has no readable EXIF at all, and an empty
 * object when it has EXIF but records neither focal length nor aperture.
 */
export async function readPhotoMetadata(filePath: string): Promise<PhotoMetadata | undefined> {
  // exifr's convenience `parse(path)` helper leaves the underlying FileHandle to
  // the garbage collector, which on a 20k-photo archive means thousands of
  // leaked descriptors and a stream of Node deprecation warnings. Driving the
  // Exifr class directly lets us close the handle in a `finally`.
  const reader = new ExifrReader(EXIFR_OPTIONS);
  let raw: Record<string, unknown> | undefined;

  try {
    await reader.read(filePath);
    raw = await reader.parse();
  } catch {
    // Unsupported container, truncated file, proprietary RAW exifr cannot open.
    return undefined;
  } finally {
    await reader.file?.close?.().catch(() => {});
  }

  if (!raw) return undefined;

  const metadata: PhotoMetadata = {};

  const focalLength = toNumber(raw['FocalLength']);
  if (isPositive(focalLength)) metadata.focalLength = focalLength;

  const equivalent =
    toNumber(raw['FocalLengthIn35mmFormat']) ?? toNumber(raw['FocalLengthIn35mmFilm']);
  if (isPositive(equivalent)) metadata.focalLength35mm = equivalent;

  const fNumber = toNumber(raw['FNumber']) ?? apexToFNumber(toNumber(raw['ApertureValue']));
  if (isPositive(fNumber)) metadata.fNumber = fNumber;

  // Make and Model live in IFD0, which exifr has to walk anyway to reach the
  // EXIF pointer, so grouping by camera costs no extra reads.
  if (typeof raw['Make'] === 'string') metadata.make = raw['Make'];
  if (typeof raw['Model'] === 'string') metadata.model = raw['Model'];

  return metadata;
}

/** APEX aperture value to f-number: f = sqrt(2)^Av. */
function apexToFNumber(apex: number | undefined): number | undefined {
  if (apex === undefined || !Number.isFinite(apex)) return undefined;
  return Math.SQRT2 ** apex;
}

function isPositive(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value > 0;
}

/**
 * Coerce whatever a given camera decided to write into a number.
 *
 * Most files give us a plain number, but rationals survive as `"50/1"`,
 * strings arrive as `"50 mm"`, and a few bodies write single-element arrays.
 */
function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;

  if (typeof value === 'string') {
    const fraction = /^\s*(-?\d+(?:\.\d+)?)\s*\/\s*(-?\d+(?:\.\d+)?)\s*$/.exec(value);
    if (fraction) {
      const numerator = Number(fraction[1]);
      const denominator = Number(fraction[2]);
      return denominator === 0 ? undefined : numerator / denominator;
    }
    const leading = /-?\d+(?:\.\d+)?/.exec(value);
    return leading ? Number(leading[0]) : undefined;
  }

  if (Array.isArray(value)) return value.length > 0 ? toNumber(value[0]) : undefined;

  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const numerator = record['numerator'];
    const denominator = record['denominator'];
    if (typeof numerator === 'number' && typeof denominator === 'number' && denominator !== 0) {
      return numerator / denominator;
    }
  }

  return undefined;
}
