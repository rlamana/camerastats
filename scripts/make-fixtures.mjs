/**
 * Generate the fixture tree used by the tests.
 *
 * There is no pure-JS JPEG encoder here, so the pipeline is: hand-write a tiny
 * PNG (trivial to encode), convert it with `sips`, then stamp EXIF on with
 * `exiftool`. Both ship with macOS / Homebrew. The generated tree is committed
 * so the tests do not depend on either tool being present.
 */
import { deflateSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures');

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** Minimal 8-bit RGB PNG, one solid colour. */
function png(size, [r, g, b]) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolour
  const scanline = Buffer.concat([
    Buffer.from([0]), // no filter
    Buffer.concat(Array.from({ length: size }, () => Buffer.from([r, g, b]))),
  ]);
  const raw = Buffer.concat(Array.from({ length: size }, () => scanline));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function sips(input, output, format) {
  execFileSync('sips', ['-s', 'format', format, input, '--out', output], { stdio: 'ignore' });
}

function tag(file, args) {
  execFileSync('exiftool', [...args, '-overwrite_original', file], { stdio: 'ignore' });
}

/**
 * The shot list. Focal lengths and apertures are chosen so the expected
 * percentages are exact and easy to assert on. The camera column covers the
 * naming cases that matter: Sony's internal `ILCE-` codes, a model that already
 * repeats its make (`Canon` / `Canon EOS R5`), a shouty make (`NIKON
 * CORPORATION`), a phone, and a file with no camera recorded at all.
 */
const SONY_A6700 = { make: 'SONY', model: 'ILCE-6700' };
const SONY_A7RV = { make: 'SONY', model: 'ILCE-7RM5' };
const IPHONE = { make: 'Apple', model: 'iPhone 13 Pro' };
const CANON_R5 = { make: 'Canon', model: 'Canon EOS R5' };
const NIKON_Z6 = { make: 'NIKON CORPORATION', model: 'NIKON Z 6' };
const FUJI_XT4 = { make: 'FUJIFILM', model: 'X-T4' };

const SHOTS = [
  { path: '35mm/a.jpg', focal: 35, aperture: 1.8, camera: SONY_A6700 },
  { path: '35mm/b.jpg', focal: 35, aperture: 1.8, camera: SONY_A6700 },
  { path: '35mm/c.jpg', focal: 35, aperture: 2.8, camera: SONY_A6700 },
  { path: '35mm/nested/d.jpg', focal: 35, aperture: 8, camera: SONY_A6700 },
  { path: 'tele/e.jpg', focal: 200, aperture: 2.8, camera: SONY_A7RV },
  { path: 'tele/nested/deep/f.jpg', focal: 200, aperture: 5.6, camera: SONY_A7RV },
  { path: 'wide/g.jpg', focal: 24, aperture: 11, camera: IPHONE },
  // Sub-10mm focal length, and no camera recorded: an export that kept its
  // exposure tags but lost Make/Model. Must land under "Unknown camera".
  { path: 'compact/h.jpg', focal: 8.8, aperture: 2, camera: null },
  // Near-identical focal lengths that must collapse into one 50mm bucket.
  { path: 'fifty/i.jpg', focal: 49.9, aperture: 4, camera: CANON_R5 },
  { path: 'fifty/j.jpg', focal: 50.1, aperture: 4, camera: CANON_R5 },
];

/** TIFF-based RAW stand-ins. Every one of these is a TIFF under the hood. */
const RAWS = [
  { path: 'raw/sony.arw', focal: 85, aperture: 1.4, camera: SONY_A6700 },
  { path: 'raw/canon.cr2', focal: 85, aperture: 1.4, camera: CANON_R5 },
  { path: 'raw/nikon.nef', focal: 24, aperture: 11, camera: NIKON_Z6 },
  { path: 'raw/adobe.dng', focal: 200, aperture: 2.8, camera: IPHONE },
];

rmSync(FIXTURES, { recursive: true, force: true });
mkdirSync(FIXTURES, { recursive: true });

const basePng = join(FIXTURES, '_base.png');
const baseJpg = join(FIXTURES, '_base.jpg');
const baseTiff = join(FIXTURES, '_base.tiff');
writeFileSync(basePng, png(8, [90, 140, 200]));
sips(basePng, baseJpg, 'jpeg');
sips(basePng, baseTiff, 'tiff');

for (const { path, focal, aperture, camera } of [...SHOTS, ...RAWS]) {
  const target = join(FIXTURES, path);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(path.endsWith('.jpg') ? baseJpg : baseTiff, target);
  tag(target, [
    `-EXIF:FocalLength=${focal}`,
    `-EXIF:FNumber=${aperture}`,
    ...(camera ? [`-EXIF:Make=${camera.make}`, `-EXIF:Model=${camera.model}`] : []),
  ]);
}

// A photo with no EXIF at all, and one with a body but no focal length or
// aperture: both must be counted as skipped rather than crashing the scan.
copyFileSync(basePng, join(FIXTURES, 'no-exif.png'));
const partial = join(FIXTURES, 'partial.jpg');
copyFileSync(baseJpg, partial);
tag(partial, ['-EXIF:ISO=400']);

// A crop-body shot: physical 35mm, 52mm equivalent, for --35mm.
const crop = join(FIXTURES, 'crop.jpg');
copyFileSync(baseJpg, crop);
tag(crop, [
  '-EXIF:FocalLength=35',
  '-EXIF:FocalLengthIn35mmFormat=52',
  '-EXIF:FNumber=2.8',
  `-EXIF:Make=${FUJI_XT4.make}`,
  `-EXIF:Model=${FUJI_XT4.model}`,
]);

// Not an image: must be ignored by extension.
writeFileSync(join(FIXTURES, 'notes.txt'), 'not a photo\n');
// Hidden file: skipped unless --include-hidden.
copyFileSync(baseJpg, join(FIXTURES, '.hidden.jpg'));
tag(join(FIXTURES, '.hidden.jpg'), [
  '-EXIF:FocalLength=300',
  '-EXIF:FNumber=4',
  `-EXIF:Make=${SONY_A7RV.make}`,
  `-EXIF:Model=${SONY_A7RV.model}`,
]);

rmSync(basePng);
rmSync(baseJpg);
rmSync(baseTiff);

console.log(`fixtures written to ${FIXTURES}`);
