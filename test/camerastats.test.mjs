import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, copyFile, mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  APERTURE_DIMENSION,
  DEFAULT_EXTENSIONS,
  DimensionCounter,
  FOCAL_LENGTH_35MM_DIMENSION,
  FOCAL_LENGTH_DIMENSION,
  analyze,
  extensionOf,
  parseExtensionList,
  readPhotoMetadata,
  renderCsv,
  renderReport,
  walkImages,
} from '../dist/index.js';

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'fixtures');
const CLI = join(HERE, '..', 'dist', 'cli.js');

const BASE_SCAN = {
  recursive: true,
  extensions: DEFAULT_EXTENSIONS,
  includeHidden: false,
  followSymlinks: false,
};

async function collect(scan = {}) {
  const found = [];
  for await (const file of walkImages(FIXTURES, { ...BASE_SCAN, ...scan })) found.push(file);
  return found.map((file) => file.slice(FIXTURES.length + 1)).sort();
}

function analyzeFixtures(overrides = {}) {
  return analyze({
    root: FIXTURES,
    dimensions: [FOCAL_LENGTH_DIMENSION, APERTURE_DIMENSION],
    scan: BASE_SCAN,
    ...overrides,
  });
}

const entryFor = (dimension, label) => dimension.entries.find((entry) => entry.label === label);

test('extensionOf reads the last suffix, lowercased', () => {
  assert.equal(extensionOf('/photos/DSC01234.ARW'), 'arw');
  assert.equal(extensionOf('a.b.c/IMG_0001.jpg'), 'jpg');
  assert.equal(extensionOf('/photos/README'), '');
  // A dotfile is a name, not an extension.
  assert.equal(extensionOf('/photos/.hidden'), '');
});

test('parseExtensionList normalizes dots, case and whitespace', () => {
  assert.deepEqual([...parseExtensionList(' .ARW, cr3 ,,JPG')].sort(), ['arw', 'cr3', 'jpg']);
});

test('walk finds every image and ignores non-images and dotfiles', async () => {
  const files = await collect();
  assert.equal(files.length, 17);
  assert.ok(files.includes('raw/sony.arw'));
  assert.ok(!files.some((file) => file.endsWith('notes.txt')));
  assert.ok(!files.some((file) => file.includes('.hidden.jpg')));
});

test('walk honours --no-recursive', async () => {
  assert.deepEqual(await collect({ recursive: false }), [
    'crop.jpg',
    'no-exif.png',
    'partial.jpg',
  ]);
});

test('walk honours --include-hidden and an extension filter', async () => {
  assert.ok((await collect({ includeHidden: true })).includes('.hidden.jpg'));
  assert.deepEqual(await collect({ extensions: parseExtensionList('arw,cr2') }), [
    'raw/canon.cr2',
    'raw/sony.arw',
  ]);
});

test('reads focal length and aperture from JPEG and from RAW', async () => {
  assert.deepEqual(await readPhotoMetadata(join(FIXTURES, '35mm/a.jpg')), {
    focalLength: 35,
    fNumber: 1.8,
    make: 'SONY',
    model: 'ILCE-6700',
  });
  // TIFF-based RAW: parsing must not depend on the file extension.
  assert.deepEqual(await readPhotoMetadata(join(FIXTURES, 'raw/sony.arw')), {
    focalLength: 85,
    fNumber: 1.4,
    make: 'SONY',
    model: 'ILCE-6700',
  });
});

test('distinguishes "no relevant tags" from "unparseable"', async () => {
  // Has EXIF (ISO), but neither focal length nor aperture.
  assert.deepEqual(await readPhotoMetadata(join(FIXTURES, 'partial.jpg')), {});
  assert.equal(await readPhotoMetadata(join(FIXTURES, 'notes.txt')), undefined);
});

test('analyze totals account for every file found', async () => {
  const { totals } = await analyzeFixtures();
  assert.equal(totals.files, 17);
  assert.equal(totals.withStats, 15);
  assert.equal(totals.withoutStats + totals.unreadable, 2);
  assert.equal(totals.withStats + totals.withoutStats + totals.unreadable, totals.files);
});

test('focal lengths are bucketed to whole millimetres, and percentages sum to 100', async () => {
  const [focal] = (await analyzeFixtures()).dimensions;

  // 49.9 and 50.1 are the same lens; they must not be two rows.
  assert.equal(entryFor(focal, '50mm').count, 2);
  assert.equal(entryFor(focal, '49.9mm'), undefined);

  // Sub-10mm keeps a decimal: rounding 8.8 to 9 would be a big relative error.
  assert.equal(entryFor(focal, '8.8mm').count, 1);

  assert.equal(focal.samples, 15);
  const total = focal.entries.reduce((sum, entry) => sum + entry.percentage, 0);
  assert.ok(Math.abs(total - 100) < 1e-9, `percentages summed to ${total}`);
});

test('rows are sorted by count, most used first', async () => {
  const [focal, aperture] = (await analyzeFixtures()).dimensions;
  assert.deepEqual(
    focal.entries.slice(0, 2).map((entry) => [entry.label, entry.count]),
    [
      ['35mm', 5],
      ['200mm', 3],
    ],
  );
  assert.equal(aperture.entries[0].label, 'f/2.8');
  for (let i = 1; i < focal.entries.length; i += 1) {
    assert.ok(focal.entries[i - 1].count >= focal.entries[i].count);
  }
});

test('apertures are labelled as f-numbers without trailing zeroes', async () => {
  const [, aperture] = (await analyzeFixtures()).dimensions;
  const labels = aperture.entries.map((entry) => entry.label);
  assert.ok(labels.includes('f/5.6'));
  assert.ok(labels.includes('f/11'));
  assert.ok(labels.includes('f/4'), `expected "f/4" not "f/4.0", got ${labels.join(' ')}`);
});

test('sort=value orders by the number, not the tally', async () => {
  const [focal] = (await analyzeFixtures({ sort: 'value' })).dimensions;
  const values = focal.entries.map((entry) => entry.value);
  assert.deepEqual(values, [...values].sort((a, b) => a - b));
});

test('--35mm prefers the equivalent focal length when the camera recorded one', async () => {
  const [physical] = (await analyzeFixtures()).dimensions;
  const [equivalent] = (
    await analyzeFixtures({ dimensions: [FOCAL_LENGTH_35MM_DIMENSION, APERTURE_DIMENSION] })
  ).dimensions;

  // crop.jpg is 35mm physical / 52mm equivalent; it should move buckets.
  assert.equal(entryFor(physical, '35mm').count, 5);
  assert.equal(entryFor(physical, '52mm'), undefined);
  assert.equal(entryFor(equivalent, '35mm').count, 4);
  assert.equal(entryFor(equivalent, '52mm').count, 1);
});

test('concurrency does not change the result', async () => {
  const serial = await analyzeFixtures({ concurrency: 1 });
  const parallel = await analyzeFixtures({ concurrency: 32 });
  assert.deepEqual(serial.dimensions, parallel.dimensions);
  assert.deepEqual(serial.totals, parallel.totals);
});

test('an empty tally renders as "no data" rather than NaN', () => {
  const empty = new DimensionCounter(FOCAL_LENGTH_DIMENSION).result();
  assert.deepEqual(empty.entries, []);
  assert.equal(empty.samples, 0);
  const text = renderReport(
    {
      root: '/tmp',
      totals: { files: 0, withStats: 0, withoutStats: 0, unreadable: 0, filtered: 0 },
      dimensions: [empty],
      cameras: [],
      errors: [],
      durationMs: 0,
    },
    { top: 20, color: false, barWidth: 20 },
  );
  assert.match(text, /no data/);
  assert.doesNotMatch(text, /NaN/);
});

test('--top truncates rows without rescaling the bars', async () => {
  const result = await analyzeFixtures();
  const options = { color: false, barWidth: 20 };
  const full = renderReport(result, { ...options, top: 0 });
  const topped = renderReport(result, { ...options, top: 2 });

  const barOf = (text, label) =>
    text.split('\n').find((line) => line.trimStart().startsWith(`${label} `));

  assert.equal(barOf(full, '35mm'), barOf(topped, '35mm'));
  assert.match(topped, /… and \d+ more/);
});

test('CSV output carries both statistics, tagged by camera', async () => {
  const combined = renderCsv(await analyzeFixtures(), 0).split('\n');
  assert.equal(combined[0], 'camera,stat,value,label,count,percentage');
  assert.ok(combined.some((line) => line.startsWith('(all),focalLength,35,35mm,5,')));
  assert.ok(combined.some((line) => line.startsWith('(all),aperture,2.8,f/2.8,4,')));

  const grouped = renderCsv(await analyzeFixtures({ groupByCamera: true }), 0).split('\n');
  assert.ok(grouped.some((line) => line.startsWith('Sony a6700,focalLength,35,35mm,4,')));
  assert.ok(!grouped.some((line) => line.startsWith('(all),')));
});

test('CSV quotes camera names containing commas', () => {
  const csv = renderCsv(
    {
      root: '/tmp',
      totals: { files: 1, withStats: 1, withoutStats: 0, unreadable: 0, filtered: 0 },
      dimensions: [],
      cameras: [
        {
          camera: { name: 'Weird "Brand", Ltd. X1' },
          photos: 1,
          percentage: 100,
          dimensions: [
            {
              id: 'focalLength',
              title: 'Focal length',
              samples: 1,
              entries: [{ value: 35, label: '35mm', count: 1, percentage: 100 }],
            },
          ],
        },
      ],
      errors: [],
      durationMs: 0,
    },
    0,
  );
  assert.match(csv, /^"Weird ""Brand"", Ltd\. X1",focalLength,35,35mm,1,100\.0000$/m);
});

test('CLI reports both statistics and exits 0', async () => {
  const { stdout } = await run('node', [
    CLI,
    FIXTURES,
    '--combined',
    '--no-color',
    '--no-progress',
  ]);
  assert.match(stdout, /Focal length \(15 photos\)/);
  assert.match(stdout, /Aperture \(15 photos\)/);
  assert.match(stdout, /35mm.*33\.3%.*5/);
});

test('CLI defaults to the current directory', async () => {
  const { stdout } = await run('node', [CLI, '--no-color', '--no-progress', '--json'], {
    cwd: FIXTURES,
  });
  assert.equal(JSON.parse(stdout).root, FIXTURES);
});

test('CLI keeps stdout clean for --json even with progress enabled', async () => {
  const { stdout } = await run('node', [CLI, FIXTURES, '--json']);
  assert.doesNotThrow(() => JSON.parse(stdout));
});

test('CLI rejects a bad option and a missing folder with exit 1', async () => {
  await assert.rejects(run('node', [CLI, '--nope']), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /Unknown option: --nope/);
    return true;
  });
  await assert.rejects(run('node', [CLI, join(FIXTURES, 'does-not-exist')]), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /cannot open folder/);
    return true;
  });
  await assert.rejects(run('node', [CLI, join(FIXTURES, 'notes.txt')]), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /not a directory/);
    return true;
  });
});

test('CLI --help and --version exit 0', async () => {
  assert.match((await run('node', [CLI, '--help'])).stdout, /Usage/);
  assert.match((await run('node', [CLI, '--version'])).stdout, /^\d+\.\d+\.\d+/);
  assert.match((await run('node', [CLI, '--list-extensions'])).stdout, /Sony\s+arw/);
});

async function withTempDir(body) {
  const dir = await mkdtemp(join(tmpdir(), 'camerastats-'));
  try {
    return await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

test('a symlink cycle terminates and each photo is counted once', async () => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, 'sub'), { recursive: true });
    await copyFile(join(FIXTURES, '35mm/a.jpg'), join(dir, 'a.jpg'));
    await symlink(dir, join(dir, 'sub', 'back'), 'dir');

    const { stdout } = await run('node', [CLI, dir, '--follow-symlinks', '--json'], {
      timeout: 30_000,
    });
    const report = JSON.parse(stdout);
    assert.equal(report.totals.files, 1);
    assert.deepEqual(
      report.stats.focalLength.entries.map((entry) => [entry.label, entry.count]),
      [['35mm', 1]],
    );
  });
});

test('an unreadable folder is reported, not silently read as empty', async () => {
  await withTempDir(async (dir) => {
    const locked = join(dir, 'locked');
    await mkdir(locked, { recursive: true });
    await copyFile(join(FIXTURES, '35mm/a.jpg'), join(locked, 'a.jpg'));
    await chmod(locked, 0o000);
    try {
      // Nothing readable at all: saying "no images found" alone would be a lie.
      await assert.rejects(run('node', [CLI, dir, '--no-color', '--no-progress']), (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /could not read/);
        assert.match(error.stderr, /EACCES/);
        return true;
      });
    } finally {
      await chmod(locked, 0o755);
    }
  });
});
