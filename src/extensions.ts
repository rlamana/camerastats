/**
 * Registry of file extensions we are willing to open.
 *
 * Nearly every RAW format is a TIFF derivative, which is why a single EXIF
 * parser can cover such a wide range of vendors. The handful that are not
 * (X3F, R3D, ARI, ...) are still listed so that they show up in the scan as
 * "unreadable" rather than being silently ignored — that difference matters
 * when you are trying to work out why a folder looks emptier than it is.
 */

/** Standard, non-RAW image containers. */
export const STANDARD_EXTENSIONS = [
  'jpg',
  'jpeg',
  'jpe',
  'jfif',
  'tif',
  'tiff',
  'png',
  'webp',
  'heic',
  'heif',
  'hif',
  'avif',
] as const;

/** RAW formats, keyed by the vendor that introduced them. */
export const RAW_EXTENSIONS_BY_VENDOR: Readonly<Record<string, readonly string[]>> = {
  Adobe: ['dng'],
  ARRI: ['ari'],
  Canon: ['crw', 'cr2', 'cr3'],
  Casio: ['bay'],
  Epson: ['erf'],
  Fujifilm: ['raf'],
  GoPro: ['gpr'],
  Hasselblad: ['3fr', 'fff'],
  Kodak: ['dcr', 'dcs', 'drf', 'k25', 'kdc'],
  Leaf: ['mos'],
  Leica: ['rwl', 'raw', 'rwz'],
  Mamiya: ['mef'],
  Minolta: ['mrw'],
  Nikon: ['nef', 'nrw'],
  Olympus: ['orf'],
  Panasonic: ['rw2'],
  Pentax: ['pef', 'ptx'],
  'Phase One': ['iiq', 'cap', 'eip'],
  RED: ['r3d'],
  Ricoh: ['rdc'],
  Samsung: ['srw'],
  Sigma: ['x3f'],
  Sony: ['arw', 'srf', 'sr2'],
};

/** Every RAW extension, de-duplicated and sorted. */
export const RAW_EXTENSIONS: readonly string[] = [
  ...new Set(Object.values(RAW_EXTENSIONS_BY_VENDOR).flat()),
].sort();

/** Every extension the scanner will pick up by default. */
export const DEFAULT_EXTENSIONS: ReadonlySet<string> = new Set([
  ...STANDARD_EXTENSIONS,
  ...RAW_EXTENSIONS,
]);

/** Directories that are never worth walking into. */
export const IGNORED_DIRECTORIES: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  '$RECYCLE.BIN',
  'System Volume Information',
  // Lightroom / Capture One / Photos sidecar and cache bundles.
  'Lightroom Settings',
  'CaptureOne',
]);

/** Lowercase extension without the leading dot, or `''` if there is none. */
export function extensionOf(filePath: string): string {
  const base = filePath.slice(filePath.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase();
}

/** Normalize a user-supplied extension list (`"arw,.CR3"`) into a lookup set. */
export function parseExtensionList(value: string): Set<string> {
  return new Set(
    value
      .split(',')
      .map((part) => part.trim().replace(/^\./, '').toLowerCase())
      .filter(Boolean),
  );
}

/**
 * Directory *suffixes* that mark an application bundle. macOS shows these as
 * single documents, and their innards are caches and derivatives — counting
 * them would double-count the originals that live alongside.
 */
export const IGNORED_DIRECTORY_SUFFIXES: readonly string[] = [
  '.photoslibrary',
  '.aplibrary',
  '.migratedaplibrary',
  '.lrdata',
  '.lrcat-data',
  '.cosessiondb',
];

/** True when a directory should not be descended into. */
export function isIgnoredDirectory(name: string): boolean {
  if (IGNORED_DIRECTORIES.has(name)) return true;
  const lower = name.toLowerCase();
  return IGNORED_DIRECTORY_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}
