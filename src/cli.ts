#!/usr/bin/env node
import { stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { availableParallelism } from 'node:os';
import { resolve } from 'node:path';

import { analyze } from './analyze.js';
import {
  DEFAULT_EXTENSIONS,
  RAW_EXTENSIONS_BY_VENDOR,
  STANDARD_EXTENSIONS,
  parseExtensionList,
} from './extensions.js';
import { formatNumber, renderCsv, renderJson, renderReport } from './format.js';
import {
  APERTURE_DIMENSION,
  FOCAL_LENGTH_35MM_DIMENSION,
  FOCAL_LENGTH_DIMENSION,
  type DimensionSpec,
  type SortMode,
} from './stats.js';

interface CliOptions {
  folder: string;
  recursive: boolean;
  top: number;
  sort: SortMode;
  format: 'text' | 'json' | 'csv';
  equivalent35mm: boolean;
  byCamera: boolean;
  cameraFilter?: string;
  extensions: ReadonlySet<string>;
  includeHidden: boolean;
  followSymlinks: boolean;
  concurrency: number;
  color: boolean;
  progress: boolean;
}

class UsageError extends Error {}

const require = createRequire(import.meta.url);
const { version } = require('../package.json') as { version: string };

const HELP = `
camerastats ${version}

  Scan a folder of photos and report which focal lengths and apertures you
  actually shoot with. Reads JPEG, TIFF, PNG, HEIC/AVIF and camera RAW
  (Sony ARW, Canon CR2/CR3, Nikon NEF, Fujifilm RAF, Adobe DNG, and more).

Usage
  camerastats [folder] [options]

  folder                  Folder to scan. Defaults to the current directory.

Options
  -R, --no-recursive      Only scan the given folder, not its subfolders.
  -t, --top <n>           Show at most n rows per statistic (0 = all). Default 20.
  -s, --sort <mode>       Order rows by "count" (default) or "value".
      --35mm              Use the camera's 35mm-equivalent focal length when available.
      --combined          One set of tables for everything, instead of per camera.
      --camera <text>     Only photos whose camera name contains <text>, e.g. "a6700".
  -e, --ext <list>        Only scan these extensions, e.g. "arw,cr3,jpg".
      --json              Print the report as JSON.
      --csv               Print the report as CSV.
  -c, --concurrency <n>   Files parsed in parallel. Default ${defaultConcurrency()}.
      --include-hidden    Include dot-files and dot-folders.
      --follow-symlinks   Follow symlinked folders (cycles are skipped).
      --no-color          Disable coloured output.
      --no-progress       Disable the progress counter.
      --list-extensions   Print every extension that is scanned by default.
  -h, --help              Show this help.
  -v, --version           Show the version.

Examples
  camerastats
  camerastats ~/Pictures/2025 --top 10
  camerastats ~/Photos --camera a6700
  camerastats ~/Photos --combined
  camerastats /Volumes/CARD --ext arw --no-recursive
  camerastats ~/Photos --35mm --json > stats.json
`;

function defaultConcurrency(): number {
  // EXIF reads are I/O bound: oversubscribing the CPU count pays off, but
  // going much past this starts to thrash the file descriptor table.
  return Math.min(32, Math.max(4, availableParallelism() * 2));
}

function parseArguments(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    folder: process.cwd(),
    recursive: true,
    top: 20,
    sort: 'count',
    format: 'text',
    equivalent35mm: false,
    byCamera: true,
    extensions: DEFAULT_EXTENSIONS,
    includeHidden: false,
    followSymlinks: false,
    concurrency: defaultConcurrency(),
    color: supportsColor(),
    progress: process.stderr.isTTY === true,
  };

  let folderSeen = false;
  let index = 0;

  const valueOf = (flag: string, inline: string | undefined): string => {
    if (inline !== undefined) return inline;
    const next = argv[++index];
    if (next === undefined) throw new UsageError(`${flag} requires a value.`);
    return next;
  };

  for (; index < argv.length; index += 1) {
    const argument = argv[index]!;

    if (argument === '--') {
      const rest = argv.slice(index + 1);
      if (rest.length > 0) {
        options.folder = rest[0]!;
        folderSeen = true;
      }
      break;
    }

    if (!argument.startsWith('-') || argument === '-') {
      if (folderSeen) throw new UsageError(`Unexpected extra argument: ${argument}`);
      options.folder = argument;
      folderSeen = true;
      continue;
    }

    const separator = argument.indexOf('=');
    const flag = separator === -1 ? argument : argument.slice(0, separator);
    const inline = separator === -1 ? undefined : argument.slice(separator + 1);

    switch (flag) {
      case '-h':
      case '--help':
        process.stdout.write(`${HELP.trimStart()}\n`);
        process.exit(0);
      case '-v':
      case '--version':
        process.stdout.write(`${version}\n`);
        process.exit(0);
      case '--list-extensions':
        process.stdout.write(listExtensions());
        process.exit(0);
      case '-r':
      case '--recursive':
        options.recursive = true;
        break;
      case '-R':
      case '--no-recursive':
        options.recursive = false;
        break;
      case '-t':
      case '--top':
        options.top = parseCount(flag, valueOf(flag, inline));
        break;
      case '-s':
      case '--sort': {
        const mode = valueOf(flag, inline);
        if (mode !== 'count' && mode !== 'value') {
          throw new UsageError(`--sort must be "count" or "value", got "${mode}".`);
        }
        options.sort = mode;
        break;
      }
      case '--35mm':
        options.equivalent35mm = true;
        break;
      case '--combined':
      case '--no-by-camera':
        options.byCamera = false;
        break;
      case '--by-camera':
        options.byCamera = true;
        break;
      case '--camera': {
        const needle = valueOf(flag, inline).trim();
        if (needle === '') throw new UsageError('--camera needs some text to match.');
        options.cameraFilter = needle;
        break;
      }
      case '-e':
      case '--ext': {
        const extensions = parseExtensionList(valueOf(flag, inline));
        if (extensions.size === 0) throw new UsageError('--ext needs at least one extension.');
        options.extensions = extensions;
        break;
      }
      case '--json':
        options.format = 'json';
        break;
      case '--csv':
        options.format = 'csv';
        break;
      case '-c':
      case '--concurrency': {
        const concurrency = parseCount(flag, valueOf(flag, inline));
        if (concurrency < 1) throw new UsageError('--concurrency must be at least 1.');
        options.concurrency = concurrency;
        break;
      }
      case '--include-hidden':
        options.includeHidden = true;
        break;
      case '--follow-symlinks':
        options.followSymlinks = true;
        break;
      case '--color':
        options.color = true;
        break;
      case '--no-color':
        options.color = false;
        break;
      case '--no-progress':
        options.progress = false;
        break;
      default:
        throw new UsageError(`Unknown option: ${flag}`);
    }
  }

  // Structured output goes to stdout; keeping it clean matters more than the chrome.
  if (options.format !== 'text') options.color = false;

  return options;
}

function parseCount(flag: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new UsageError(`${flag} expects a non-negative integer, got "${raw}".`);
  }
  return value;
}

function supportsColor(): boolean {
  if (process.env['NO_COLOR'] !== undefined && process.env['NO_COLOR'] !== '') return false;
  if (process.env['FORCE_COLOR'] !== undefined && process.env['FORCE_COLOR'] !== '0') return true;
  return process.stdout.isTTY === true;
}

function listExtensions(): string {
  const lines = [`Standard: ${STANDARD_EXTENSIONS.join(', ')}`, '', 'RAW:'];
  for (const [vendor, extensions] of Object.entries(RAW_EXTENSIONS_BY_VENDOR)) {
    lines.push(`  ${vendor.padEnd(12)} ${extensions.join(', ')}`);
  }
  return `${lines.join('\n')}\n`;
}

async function main(): Promise<number> {
  let options: CliOptions;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`camerastats: ${error.message}\nTry "camerastats --help".\n`);
    return 1;
  }

  const root = resolve(options.folder);
  try {
    const info = await stat(root);
    if (!info.isDirectory()) {
      process.stderr.write(`camerastats: not a directory: ${root}\n`);
      return 1;
    }
  } catch {
    process.stderr.write(`camerastats: cannot open folder: ${root}\n`);
    return 1;
  }

  const focalLength: DimensionSpec = options.equivalent35mm
    ? FOCAL_LENGTH_35MM_DIMENSION
    : FOCAL_LENGTH_DIMENSION;

  const progress = options.progress ? createProgressReporter() : undefined;

  const needle = options.cameraFilter?.toLowerCase();

  const result = await analyze({
    root,
    dimensions: [focalLength, APERTURE_DIMENSION],
    sort: options.sort,
    groupByCamera: options.byCamera,
    ...(needle ? { cameraFilter: (name: string) => name.toLowerCase().includes(needle) } : {}),
    concurrency: options.concurrency,
    scan: {
      recursive: options.recursive,
      extensions: options.extensions,
      includeHidden: options.includeHidden,
      followSymlinks: options.followSymlinks,
    },
    onProgress: progress?.update,
  });

  progress?.clear();

  if (options.format === 'json') {
    process.stdout.write(`${renderJson(result, options.top)}\n`);
    return 0;
  }

  if (options.format === 'csv') {
    process.stdout.write(`${renderCsv(result, options.top)}\n`);
    return 0;
  }

  if (options.cameraFilter && result.totals.withStats === 0 && result.totals.files > 0) {
    process.stderr.write(
      `camerastats: no photos from a camera matching "${options.cameraFilter}"` +
        ` (${formatNumber(result.totals.filtered)} photo(s) came from other cameras)\n`,
    );
    return 0;
  }

  if (result.totals.files === 0) {
    process.stderr.write(
      `camerastats: no image files found in ${root}` +
        `${options.recursive ? '' : ' (subfolders not scanned; drop --no-recursive to include them)'}\n`,
    );
    // Still surface I/O errors here: "no images found" is a misleading thing to
    // say on its own when the real reason is a folder we were not allowed to open.
    for (const error of result.errors) {
      process.stderr.write(`camerastats: could not read ${error.path}: ${error.message}\n`);
    }
    return result.errors.length > 0 ? 1 : 0;
  }

  process.stdout.write(
    renderReport(result, { top: options.top, color: options.color, barWidth: barWidth() }),
  );
  return 0;
}

function barWidth(): number {
  const columns = process.stdout.columns ?? 80;
  return Math.max(10, Math.min(40, columns - 40));
}

/** Throttled `\r`-rewritten counter on stderr, so it never pollutes stdout. */
function createProgressReporter(): { update: (processed: number) => void; clear: () => void } {
  let lastDrawnAt = 0;
  let width = 0;

  const draw = (text: string): void => {
    process.stderr.write(`\r${text.padEnd(width)}`);
    width = Math.max(width, text.length);
  };

  return {
    update: (processed) => {
      const now = performance.now();
      if (now - lastDrawnAt < 100) return;
      lastDrawnAt = now;
      draw(`Scanning… ${formatNumber(processed)} files`);
    },
    clear: () => {
      if (width > 0) process.stderr.write(`\r${' '.repeat(width)}\r`);
    },
  };
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`camerastats: ${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
