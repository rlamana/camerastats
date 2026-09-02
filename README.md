# camerastats

Scan a folder of photos and find out which focal lengths and apertures you
actually shoot with.

Point it at a folder — a card, a year of exports, your whole archive — and it
reads the EXIF from every image it finds, including camera RAW, and prints the
distribution for each camera you shoot with, sorted by most used.

```
$ camerastats ~/Pictures
camerastats /Users/you/Pictures
23,040 images found · 22,578 with focal length or aperture · 462 without · 4.0s
2 cameras

Sony a6700 — 8,432 photos (37.3%)
  Focal length (8,432 photos)
    16mm  ██████████████████████████████████  41.1%  3,464
    55mm  ████████████████████████████████▋   39.4%  3,321
    24mm  ████                                 4.8%    405
    … and 12 more
  Aperture (8,432 photos)
    f/2.8  ██████████████████████████████████  52.0%  4,384
    f/5.6  ██████████▋                         16.3%  1,374
      f/4  ███████                             10.7%    900
    … and 5 more

Apple iPhone 13 Pro — 6,120 photos (27.1%)
  Focal length (6,120 photos)
    5.7mm  ██████████████████████████████████  32.3%  1,974
      9mm  █████████████████████████████████▎  31.6%  1,934
    1.6mm  ███████████████████████▏            21.9%  1,341
    … and 3 more
  Aperture (6,120 photos)
    f/1.5  ██████████████████████████████████  32.3%  1,974
    f/2.8  █████████████████████████████████▎  31.6%  1,934
    f/1.8  ███████████████████████▏            21.9%  1,341
    … and 2 more
```

(Illustrative figures, rendered by the real formatter.) Pass `--combined` for
one set of tables across everything, or `--camera a6700` to narrow the whole
report to a single body.

## Install

```sh
npm install -g camerastats
```

Or run it without installing:

```sh
npx camerastats ~/Pictures
```

Requires Node 18 or newer.

## Usage

```
camerastats [folder] [options]
```

`folder` defaults to the current directory. Subfolders are scanned unless you
pass `--no-recursive`.

| Option | Description |
| --- | --- |
| `-R, --no-recursive` | Only scan the given folder, not its subfolders. |
| `-t, --top <n>` | Show at most `n` rows per statistic (`0` = all). Default `20`. |
| `-s, --sort <mode>` | Order rows by `count` (default) or `value`. |
| `--35mm` | Use the camera's 35mm-equivalent focal length where available. |
| `--combined` | One set of tables for everything, instead of one per camera. |
| `--camera <text>` | Only photos whose camera name contains `<text>`, e.g. `a6700`. Case-insensitive. |
| `-e, --ext <list>` | Only scan these extensions, e.g. `arw,cr3,jpg`. |
| `--json` | Print the report as JSON. |
| `--csv` | Print the report as CSV. |
| `-c, --concurrency <n>` | Files parsed in parallel. Defaults to 2× your CPU count, clamped to 4–32. |
| `--include-hidden` | Include dot-files and dot-folders. |
| `--follow-symlinks` | Follow symlinked folders. Cycles are detected and skipped. |
| `--no-color` | Disable coloured output. |
| `--no-progress` | Disable the progress counter. |
| `--list-extensions` | Print every extension scanned by default. |
| `-h, --help` / `-v, --version` | |

### Examples

```sh
# What lens do I actually reach for, on each body?
camerastats ~/Pictures/2025 --top 10

# Just the a6700
camerastats ~/Pictures --camera a6700

# Everything pooled together, ignoring which camera took it
camerastats ~/Pictures --combined

# Just the RAWs on the card, no subfolders
camerastats /Volumes/CARD --ext arw --no-recursive

# Compare a crop body and a full-frame body on equal terms
camerastats ~/Photos --35mm

# Feed it into something else
camerastats ~/Photos --json > stats.json
camerastats ~/Photos --csv | column -t -s,
```

## Supported formats

Standard: JPEG, TIFF, PNG, WebP, HEIC/HEIF, AVIF.

RAW, by vendor:

| Vendor | Extensions |
| --- | --- |
| Adobe | `dng` |
| Canon | `crw` `cr2` `cr3` |
| Sony | `arw` `srf` `sr2` |
| Nikon | `nef` `nrw` |
| Fujifilm | `raf` |
| Olympus | `orf` |
| Panasonic | `rw2` |
| Pentax | `pef` `ptx` |
| Leica | `rwl` `raw` `rwz` |
| Hasselblad | `3fr` `fff` |
| Phase One | `iiq` `cap` `eip` |
| Samsung | `srw` |
| Sigma | `x3f` |
| Kodak | `dcr` `dcs` `drf` `k25` `kdc` |
| Minolta | `mrw` |
| Mamiya · Leaf | `mef` `mos` |
| Epson · Casio · Ricoh | `erf` `bay` `rdc` |
| GoPro · ARRI · RED | `gpr` `ari` `r3d` |

Most RAW formats are TIFF derivatives, which is why one parser covers so many
of them. A few (X3F, R3D, ARI) are not, and may not yield metadata — they are
still counted, and reported as unreadable rather than quietly dropped.

Run `camerastats --list-extensions` for the current list.

## Grouping by camera

Statistics are broken down per camera by default, identified from the EXIF
`Make` and `Model` tags. Percentages within a camera's tables are relative to
that camera's own photos, so "41% at 16mm" means 41% of the a6700's shots — not
41% of everything.

Model names are cleaned up for display:

| EXIF `Make` / `Model` | Shown as |
| --- | --- |
| `SONY` / `ILCE-6700` | Sony a6700 |
| `SONY` / `ILCE-7RM5` | Sony a7R V |
| `Apple` / `iPhone 13 Pro` | Apple iPhone 13 Pro |
| `Canon` / `Canon EOS R5` | Canon EOS R5 |
| `NIKON CORPORATION` / `NIKON Z 6` | Nikon Z 6 |
| `FUJIFILM` / `X-T4` | Fujifilm X-T4 |

Sony's `ILCE-` and `DSC-` codes are translated mechanically — strip the prefix,
turn a trailing `M<n>` into a mark number — rather than from a lookup table, so
bodies I have never seen still come out right. Anything that does not fit the
pattern is left exactly as the camera recorded it. `--json` always carries the
raw `make` and `model` strings alongside the display name, so nothing is lost.

Photos that record a focal length or aperture but no camera are grouped under
**Unknown camera**. Files that record neither — screenshots, exported graphics —
are counted as "without" and do not create a phantom camera group.

## How the numbers are worked out

- **Percentages are relative to the photos that reported that tag**, not to
  every file scanned. If 900 of 1,000 photos record an aperture, the aperture
  percentages are out of 900. Each statistic prints its own sample size.
- **Focal lengths are bucketed to whole millimetres**, because the same lens
  reports 49.9, 50.0 and 50.1 depending on the body. Below 10mm they keep one
  decimal, where 1mm is a large relative step.
- **Apertures are bucketed to one decimal**, so f/5.6 stays distinct from f/5.0.
- **`FocalLength` and `FNumber` are read from the standard EXIF IFD.** Where a
  vendor MakerNote disagrees with EXIF, the EXIF value wins.
- **Bars are scaled to the largest bucket**, not to 100%, so `--top` and
  `--sort` never change what a full-width bar means.

Files are counted in one of three ways: they reported a focal length or
aperture, they were readable but recorded neither, or they could not be parsed
at all. Every file found lands in exactly one of those buckets.

## Use as a library

```ts
import { analyze, FOCAL_LENGTH_DIMENSION, APERTURE_DIMENSION, DEFAULT_EXTENSIONS } from 'camerastats';

const result = await analyze({
  root: '/Users/you/Pictures',
  dimensions: [FOCAL_LENGTH_DIMENSION, APERTURE_DIMENSION],
  groupByCamera: true,
  scan: {
    recursive: true,
    extensions: DEFAULT_EXTENSIONS,
    includeHidden: false,
    followSymlinks: false,
  },
});

for (const group of result.cameras) {
  console.log(group.camera.name, group.photos);
  for (const entry of group.dimensions[0].entries) {
    console.log(' ', entry.label, entry.count, entry.percentage);
  }
}

// `result.dimensions` always holds the combined figures as well.
```

A statistic is just a `DimensionSpec` — how to read a number out of the
metadata, how to bucket it, and how to label it — so adding ISO or shutter
speed is a few lines rather than a new code path.

## Development

```sh
npm install
npm run build
npm test          # builds, then runs the suite against test/fixtures
npm run fixtures  # regenerate fixtures (needs exiftool and macOS sips)
npm run watch     # tsc in watch mode
```

The fixture tree is committed, so the tests do not need `exiftool` installed.

Correctness of the extracted values was checked against `exiftool` over 2,000
real photos (ARW, DNG, HEIC, JPEG, TIFF) with zero disagreements on focal
length and aperture. Note that a bare `exiftool -FocalLength` reports the
*last* matching tag, which on Sony bodies is the MakerNote value rather than
the EXIF one; compare against `exiftool -EXIF:FocalLength` instead.

## License

MIT
