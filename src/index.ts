/**
 * Programmatic entry point. The CLI in `cli.ts` is a thin wrapper over these.
 *
 *   import { analyze, FOCAL_LENGTH_DIMENSION, APERTURE_DIMENSION } from 'camerastats';
 */
export { analyze } from './analyze.js';
export type {
  AnalyzeOptions,
  AnalysisResult,
  AnalysisTotals,
  CameraGroup,
} from './analyze.js';

export { UNKNOWN_CAMERA, identifyCamera } from './camera.js';
export type { CameraIdentity } from './camera.js';

export { readPhotoMetadata } from './metadata.js';
export type { PhotoMetadata } from './metadata.js';

export { walkImages } from './scanner.js';
export type { ScanOptions } from './scanner.js';

export {
  APERTURE_DIMENSION,
  DimensionCounter,
  FOCAL_LENGTH_35MM_DIMENSION,
  FOCAL_LENGTH_DIMENSION,
} from './stats.js';
export type { Dimension, DimensionSpec, SortMode, StatEntry } from './stats.js';

export {
  DEFAULT_EXTENSIONS,
  RAW_EXTENSIONS,
  RAW_EXTENSIONS_BY_VENDOR,
  STANDARD_EXTENSIONS,
  extensionOf,
  parseExtensionList,
} from './extensions.js';

export { renderCsv, renderJson, renderReport } from './format.js';
export type { RenderOptions } from './format.js';
