import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { test } from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  APERTURE_DIMENSION,
  DEFAULT_EXTENSIONS,
  FOCAL_LENGTH_DIMENSION,
  UNKNOWN_CAMERA,
  analyze,
  identifyCamera,
} from '../dist/index.js';

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'fixtures');
const CLI = join(HERE, '..', 'dist', 'cli.js');

function analyzeFixtures(overrides = {}) {
  return analyze({
    root: FIXTURES,
    dimensions: [FOCAL_LENGTH_DIMENSION, APERTURE_DIMENSION],
    scan: {
      recursive: true,
      extensions: DEFAULT_EXTENSIONS,
      includeHidden: false,
      followSymlinks: false,
    },
    ...overrides,
  });
}

const entryFor = (dimension, label) => dimension.entries.find((entry) => entry.label === label);

test('camera names are normalized from EXIF make and model', () => {
  const name = (make, model) => identifyCamera({ make, model }).name;

  // Sony records its Alpha bodies under internal codes.
  assert.equal(name('SONY', 'ILCE-6700'), 'Sony a6700');
  assert.equal(name('SONY', 'ILCE-6400'), 'Sony a6400');
  assert.equal(name('SONY', 'ILCE-7M3'), 'Sony a7 III');
  assert.equal(name('SONY', 'ILCE-7RM5'), 'Sony a7R V');
  assert.equal(name('SONY', 'ILCE-7SM3'), 'Sony a7S III');
  assert.equal(name('SONY', 'ILCE-7CM2'), 'Sony a7C II');
  assert.equal(name('SONY', 'ILCE-9M2'), 'Sony a9 II');
  assert.equal(name('SONY', 'ILCE-1'), 'Sony a1');
  assert.equal(name('SONY', 'DSC-RX100M7'), 'Sony RX100 VII');

  // A model that already carries the make must not have it prepended twice.
  assert.equal(name('Canon', 'Canon EOS R5'), 'Canon EOS R5');
  // ...and the canonical spelling wins over the shouty recorded one.
  assert.equal(name('NIKON CORPORATION', 'NIKON Z 6'), 'Nikon Z 6');

  assert.equal(name('FUJIFILM', 'X-T4'), 'Fujifilm X-T4');
  assert.equal(name('Apple', 'iPhone 13 Pro'), 'Apple iPhone 13 Pro');
  assert.equal(name('OLYMPUS IMAGING CORP.', 'E-M10MarkII'), 'Olympus E-M10MarkII');
});

test('camera naming copes with missing, padded and unknown values', () => {
  assert.equal(identifyCamera({}).name, UNKNOWN_CAMERA);
  assert.equal(identifyCamera({ make: '  ', model: ' ' }).name, UNKNOWN_CAMERA);
  assert.equal(identifyCamera({ model: 'X100V' }).name, 'X100V');
  assert.equal(identifyCamera({ make: 'SONY' }).name, 'Sony');
  // EXIF strings are NUL-padded and sometimes double-spaced.
  assert.equal(identifyCamera({ make: 'Canon ', model: 'Canon  EOS  R5 ' }).name, 'Canon EOS R5');
  // A Sony code that does not fit the pattern is left exactly as recorded.
  assert.equal(identifyCamera({ make: 'SONY', model: 'ILCE-QX1' }).name, 'Sony ILCE-QX1');
  // An unknown vendor in block capitals is title-cased rather than left shouting.
  assert.equal(identifyCamera({ make: 'ACME OPTICS', model: 'Z9' }).name, 'Acme Optics Z9');
});

test('camera groups partition exactly the photos that reported a statistic', async () => {
  const result = await analyzeFixtures({ groupByCamera: true });

  const byName = Object.fromEntries(result.cameras.map((group) => [group.camera.name, group.photos]));
  assert.deepEqual(byName, {
    'Sony a6700': 5,
    'Canon EOS R5': 3,
    'Apple iPhone 13 Pro': 2,
    'Sony a7R V': 2,
    'Fujifilm X-T4': 1,
    'Nikon Z 6': 1,
    [UNKNOWN_CAMERA]: 1,
  });

  const grouped = result.cameras.reduce((sum, group) => sum + group.photos, 0);
  assert.equal(grouped, result.totals.withStats);
  const share = result.cameras.reduce((sum, group) => sum + group.percentage, 0);
  assert.ok(Math.abs(share - 100) < 1e-9, `camera shares summed to ${share}`);
});

test('cameras are ordered by photo count, most used first', async () => {
  const { cameras } = await analyzeFixtures({ groupByCamera: true });
  for (let i = 1; i < cameras.length; i += 1) {
    assert.ok(cameras[i - 1].photos >= cameras[i].photos);
  }
  assert.equal(cameras[0].camera.name, 'Sony a6700');
});

test('a group keeps the raw EXIF strings alongside the display name', async () => {
  const { cameras } = await analyzeFixtures({ groupByCamera: true });
  const sony = cameras.find((group) => group.camera.name === 'Sony a6700');
  assert.equal(sony.camera.make, 'SONY');
  assert.equal(sony.camera.model, 'ILCE-6700');
});

test('per-camera percentages are relative to that camera alone', async () => {
  const { cameras, dimensions } = await analyzeFixtures({ groupByCamera: true });
  const sony = cameras.find((group) => group.camera.name === 'Sony a6700');
  const [focal] = sony.dimensions;

  // 4 of the a6700's 5 photos are at 35mm, so 80% within the group...
  assert.deepEqual(entryFor(focal, '35mm'), {
    value: 35,
    label: '35mm',
    count: 4,
    percentage: 80,
  });
  // ...while the same lens is 33.3% of the library as a whole.
  assert.equal(Math.round(entryFor(dimensions[0], '35mm').percentage * 10) / 10, 33.3);

  for (const group of cameras) {
    for (const dimension of group.dimensions) {
      const total = dimension.entries.reduce((sum, entry) => sum + entry.percentage, 0);
      assert.ok(Math.abs(total - 100) < 1e-9, `${group.camera.name}/${dimension.id}: ${total}`);
    }
  }
});

test('photos with no camera group under "Unknown camera"; EXIF-less files do not', async () => {
  const result = await analyzeFixtures({ groupByCamera: true });
  const unknown = result.cameras.find((group) => group.camera.name === UNKNOWN_CAMERA);

  // compact/h.jpg records focal length and aperture but no Make/Model.
  assert.equal(unknown.photos, 1);
  assert.equal(entryFor(unknown.dimensions[0], '8.8mm').count, 1);
  // no-exif.png and partial.jpg record neither, so they must not invent a camera.
  assert.equal(result.totals.withoutStats, 2);
});

test('grouping does not change the combined figures', async () => {
  const flat = await analyzeFixtures();
  const grouped = await analyzeFixtures({ groupByCamera: true });
  assert.deepEqual(flat.dimensions, grouped.dimensions);
  assert.deepEqual(flat.totals, grouped.totals);
  assert.deepEqual(flat.cameras, []);
});

test('a camera filter narrows both the groups and the combined figures', async () => {
  const result = await analyzeFixtures({
    groupByCamera: true,
    cameraFilter: (name) => name.includes('a6700'),
  });

  assert.equal(result.cameras.length, 1);
  assert.equal(result.cameras[0].photos, 5);
  assert.equal(result.dimensions[0].samples, 5);
  assert.equal(result.totals.withStats, 5);
  assert.equal(result.totals.filtered, 10);

  const { files, withStats, withoutStats, unreadable, filtered } = result.totals;
  assert.equal(withStats + withoutStats + unreadable + filtered, files);
});

test('CLI groups by camera by default', async () => {
  const { stdout } = await run('node', [CLI, FIXTURES, '--no-color', '--no-progress']);
  assert.match(stdout, /7 cameras/);
  assert.match(stdout, /Sony a6700 .* 5 photos \(33\.3%\)/);
  assert.match(stdout, /Apple iPhone 13 Pro .* 2 photos/);
  // Percentages inside a group are relative to that camera, not the whole scan.
  assert.match(stdout, /35mm.*80\.0%.*4/);
});

test('CLI --combined restores a single set of tables', async () => {
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
  assert.doesNotMatch(stdout, /Sony a6700/);
});

test('CLI --camera narrows the whole report to one camera', async () => {
  const { stdout } = await run('node', [CLI, FIXTURES, '--camera', 'a6700', '--json']);
  const report = JSON.parse(stdout);

  assert.equal(report.cameras.length, 1);
  assert.equal(report.cameras[0].name, 'Sony a6700');
  assert.equal(report.totals.withStats, 5);
  // The two EXIF-less files have no camera at all, so they count as "without
  // stats" rather than as photos from another camera.
  assert.equal(report.totals.withoutStats, 2);
  assert.equal(report.totals.filtered, 10);
  // Combined figures are narrowed too, so every number describes the same set.
  assert.equal(report.stats.focalLength.samples, 5);
});

test('CLI --camera matches case-insensitively and reports a miss', async () => {
  const { stdout } = await run('node', [CLI, FIXTURES, '--camera', 'IPHONE', '--json']);
  assert.equal(JSON.parse(stdout).cameras[0].name, 'Apple iPhone 13 Pro');

  const miss = await run('node', [CLI, FIXTURES, '--camera', 'hasselblad', '--no-progress']);
  assert.match(miss.stderr, /no photos from a camera matching "hasselblad"/);
});
