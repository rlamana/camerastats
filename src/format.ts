import type { AnalysisResult, CameraGroup } from './analyze.js';
import type { Dimension } from './stats.js';

export interface RenderOptions {
  /** Show at most this many rows per statistic (0 = all). */
  top: number;
  /** Emit ANSI colour. */
  color: boolean;
  /** Width of the bar column, in characters. */
  barWidth: number;
}

const BAR_FULL = '█';
const BAR_PARTIALS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'];

const ESC = String.fromCharCode(27);
const ANSI = {
  reset: `${ESC}[0m`,
  bold: `${ESC}[1m`,
  dim: `${ESC}[2m`,
  cyan: `${ESC}[36m`,
  yellow: `${ESC}[33m`,
};

export function formatNumber(value: number): string {
  return value.toLocaleString('en-US');
}

const plural = (count: number, word: string): string =>
  `${formatNumber(count)} ${word}${count === 1 ? '' : 's'}`;

/** Render the whole report: header, statistics, then any errors. */
export function renderReport(result: AnalysisResult, options: RenderOptions): string {
  const paint = makePainter(options.color);
  const { totals } = result;
  const lines: string[] = [];

  lines.push('');
  lines.push(`${paint(ANSI.bold, 'camerastats')} ${paint(ANSI.dim, result.root)}`);

  const summary = [
    `${plural(totals.files, 'image')} found`,
    `${formatNumber(totals.withStats)} with focal length or aperture`,
  ];
  if (totals.withoutStats > 0) summary.push(`${formatNumber(totals.withoutStats)} without`);
  if (totals.unreadable > 0) summary.push(`${formatNumber(totals.unreadable)} unreadable`);
  if (totals.filtered > 0) summary.push(`${formatNumber(totals.filtered)} from other cameras`);
  summary.push(`${(result.durationMs / 1000).toFixed(1)}s`);
  lines.push(paint(ANSI.dim, summary.join(' · ')));

  if (result.cameras.length > 0) {
    lines.push(paint(ANSI.dim, plural(result.cameras.length, 'camera')));
    for (const group of result.cameras) {
      lines.push('');
      lines.push(...renderCameraGroup(group, options, paint));
    }
  } else {
    for (const dimension of result.dimensions) {
      lines.push('');
      lines.push(...renderDimension(dimension, options, paint, ''));
    }
  }

  if (result.errors.length > 0) {
    lines.push('');
    lines.push(paint(ANSI.yellow, `${result.errors.length} path(s) could not be read:`));
    for (const error of result.errors) {
      lines.push(paint(ANSI.dim, `  ${error.path}: ${error.message}`));
    }
  }

  lines.push('');
  return lines.join('\n');
}

/** A camera heading, with that camera's statistics indented beneath it. */
function renderCameraGroup(group: CameraGroup, options: RenderOptions, paint: Painter): string[] {
  const heading =
    `${paint(ANSI.bold, group.camera.name)} ` +
    paint(ANSI.dim, `— ${plural(group.photos, 'photo')} (${group.percentage.toFixed(1)}%)`);

  const indent = '  ';
  const nested: RenderOptions = { ...options, barWidth: Math.max(10, options.barWidth - 2) };

  return [
    heading,
    ...group.dimensions.flatMap((dimension) => renderDimension(dimension, nested, paint, indent)),
  ];
}

function renderDimension(
  dimension: Dimension,
  options: RenderOptions,
  paint: Painter,
  indent: string,
): string[] {
  const heading =
    `${indent}${paint(ANSI.bold, dimension.title)} ` +
    paint(ANSI.dim, `(${plural(dimension.samples, 'photo')})`);

  if (dimension.entries.length === 0) return [heading, paint(ANSI.dim, `${indent}  no data`)];

  const shown = options.top > 0 ? dimension.entries.slice(0, options.top) : dimension.entries;
  const hidden = dimension.entries.length - shown.length;

  const labelWidth = Math.max(...shown.map((entry) => entry.label.length));
  const countWidth = Math.max(...shown.map((entry) => formatNumber(entry.count).length));
  // Bars are scaled against the largest bucket rather than against 100%, so a
  // flat distribution still produces a readable chart. The scale comes from
  // every entry, not just the visible ones, so --top and --sort do not silently
  // change what a full-width bar means.
  const maxPercentage = Math.max(...dimension.entries.map((entry) => entry.percentage));

  const rows = shown.map((entry) => {
    const label = entry.label.padStart(labelWidth);
    const bar = renderBar(entry.percentage / maxPercentage, options.barWidth);
    const percentage = `${entry.percentage.toFixed(1)}%`.padStart(6);
    const count = formatNumber(entry.count).padStart(countWidth);
    return `${indent}  ${label}  ${paint(ANSI.cyan, bar)} ${percentage}  ${paint(ANSI.dim, count)}`;
  });

  if (hidden > 0) rows.push(paint(ANSI.dim, `${indent}  … and ${formatNumber(hidden)} more`));

  return [heading, ...rows];
}

/** Eighth-block bar, so a 0.3% row still shows a sliver instead of nothing. */
function renderBar(fraction: number, width: number): string {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
  const eighths = Math.round(clamped * width * 8);
  const full = Math.floor(eighths / 8);
  let bar = BAR_FULL.repeat(full) + (BAR_PARTIALS[eighths % 8] ?? '');
  if (bar === '' && clamped > 0) bar = BAR_PARTIALS[1]!;
  return bar.padEnd(width);
}

type Painter = (code: string, text: string) => string;

function makePainter(enabled: boolean): Painter {
  if (!enabled) return (_code, text) => text;
  return (code, text) => `${code}${text}${ANSI.reset}`;
}

function serializeDimensions(dimensions: readonly Dimension[], top: number) {
  return Object.fromEntries(
    dimensions.map((dimension) => [
      dimension.id,
      {
        title: dimension.title,
        samples: dimension.samples,
        entries: (top > 0 ? dimension.entries.slice(0, top) : dimension.entries).map((entry) => ({
          value: entry.value,
          label: entry.label,
          count: entry.count,
          percentage: Number(entry.percentage.toFixed(4)),
        })),
      },
    ]),
  );
}

/** Machine-readable form of the report. */
export function renderJson(result: AnalysisResult, top: number): string {
  return JSON.stringify(
    {
      root: result.root,
      durationMs: Math.round(result.durationMs),
      totals: result.totals,
      stats: serializeDimensions(result.dimensions, top),
      cameras: result.cameras.map((group) => ({
        name: group.camera.name,
        // The raw EXIF strings are kept so downstream tools are not stuck with
        // our display naming (`Sony a6700` vs `SONY` / `ILCE-6700`).
        make: group.camera.make ?? null,
        model: group.camera.model ?? null,
        photos: group.photos,
        percentage: Number(group.percentage.toFixed(4)),
        stats: serializeDimensions(group.dimensions, top),
      })),
      errors: result.errors,
    },
    null,
    2,
  );
}

/** Quote a CSV field only when it needs it. */
function csvField(value: string | number): string {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * CSV with one row per bucket. The `camera` column is `(all)` for the combined
 * report and the camera's name when grouping, so both shapes parse the same way.
 */
export function renderCsv(result: AnalysisResult, top: number): string {
  const rows = ['camera,stat,value,label,count,percentage'];

  const emit = (camera: string, dimensions: readonly Dimension[]): void => {
    for (const dimension of dimensions) {
      const entries = top > 0 ? dimension.entries.slice(0, top) : dimension.entries;
      for (const entry of entries) {
        rows.push(
          [camera, dimension.id, entry.value, entry.label, entry.count, entry.percentage.toFixed(4)]
            .map(csvField)
            .join(','),
        );
      }
    }
  };

  if (result.cameras.length > 0) {
    for (const group of result.cameras) emit(group.camera.name, group.dimensions);
  } else {
    emit('(all)', result.dimensions);
  }

  return rows.join('\n');
}
