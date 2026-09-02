import type { PhotoMetadata } from './metadata.js';

/** Label used for photos that record no camera make or model. */
export const UNKNOWN_CAMERA = 'Unknown camera';

export interface CameraIdentity {
  /** Display name, e.g. `Sony a6700` or `Apple iPhone 13 Pro`. */
  name: string;
  /** EXIF `Make`, cleaned but not renamed. */
  make?: string;
  /** EXIF `Model`, cleaned but not renamed. */
  model?: string;
}

/**
 * Vendors write their own name inconsistently and often in block capitals.
 * These are the spellings seen in real EXIF, mapped to how people write them.
 */
const MAKE_ALIASES: Readonly<Record<string, string>> = {
  'nikon corporation': 'Nikon',
  nikon: 'Nikon',
  'canon inc.': 'Canon',
  canon: 'Canon',
  sony: 'Sony',
  'sony corporation': 'Sony',
  fujifilm: 'Fujifilm',
  'olympus imaging corp.': 'Olympus',
  'olympus corporation': 'Olympus',
  'olympus optical co.,ltd': 'Olympus',
  'om digital solutions': 'OM System',
  'panasonic': 'Panasonic',
  'matsushita electric industrial co.,ltd.': 'Panasonic',
  'leica camera ag': 'Leica',
  'pentax corporation': 'Pentax',
  'pentax ricoh imaging company, ltd.': 'Pentax',
  'ricoh imaging company, ltd.': 'Ricoh',
  'eastman kodak company': 'Kodak',
  'phase one a/s': 'Phase One',
  'hasselblad': 'Hasselblad',
  'samsung techwin': 'Samsung',
  'samsung electronics': 'Samsung',
  sigma: 'Sigma',
  apple: 'Apple',
  google: 'Google',
  dji: 'DJI',
  gopro: 'GoPro',
  xiaomi: 'Xiaomi',
  oneplus: 'OnePlus',
  motorola: 'Motorola',
  'lg electronics': 'LG',
  huawei: 'Huawei',
};

const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];

/**
 * Sony records its Alpha bodies under internal codes: the a6700 is `ILCE-6700`
 * and the a7R V is `ILCE-7RM5`. The mapping is mechanical — strip the prefix,
 * turn a trailing `M<n>` into a mark number — so we can do it without a lookup
 * table. Anything that does not fit the pattern is left exactly as recorded.
 */
function friendlySonyModel(model: string): string | undefined {
  const alpha = /^ILCE-(\d{1,4})([RSC]?)(?:M(\d))?$/.exec(model);
  if (alpha) {
    const [, digits, variant, mark] = alpha;
    const suffix = mark ? ` ${ROMAN[Number(mark)] ?? mark}` : '';
    return `a${digits}${variant ?? ''}${suffix}`;
  }

  // Cyber-shot compacts: DSC-RX100M7 is sold as the RX100 VII.
  const cyberShot = /^DSC-([A-Z]+\d+)(?:M(\d))?$/.exec(model);
  if (cyberShot) {
    const [, base, mark] = cyberShot;
    return mark ? `${base} ${ROMAN[Number(mark)] ?? mark}` : `${base}`;
  }

  return undefined;
}

/** Trim, drop EXIF's trailing NUL padding, and collapse runs of whitespace. */
function clean(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = value.replace(/\0/g, '').replace(/\s+/g, ' ').trim();
  return cleaned === '' ? undefined : cleaned;
}

/** `SONY` -> `Sony`, `NIKON CORPORATION` -> `Nikon`, unknown makes left alone. */
function canonicalMake(make: string): string {
  const alias = MAKE_ALIASES[make.toLowerCase()];
  if (alias) return alias;
  // Shouty unknown vendors read better title-cased; mixed-case ones are already fine.
  if (make === make.toUpperCase()) {
    return make
      .toLowerCase()
      .replace(/(^|[\s-])([a-z])/g, (_match, prefix: string, letter: string) => prefix + letter.toUpperCase());
  }
  return make;
}

/**
 * Work out a display name for the camera that took a photo.
 *
 * Models frequently repeat the make (`Canon` / `Canon EOS R5`), so the make is
 * only prepended when it is not already there — and when it is, the canonical
 * spelling replaces the recorded one so `NIKON Z 6` prints as `Nikon Z 6`.
 */
export function identifyCamera(metadata: PhotoMetadata): CameraIdentity {
  const make = clean(metadata.make);
  const model = clean(metadata.model);

  if (!make && !model) return { name: UNKNOWN_CAMERA };
  if (!model) return { name: canonicalMake(make!), make };

  const vendor = make ? canonicalMake(make) : undefined;
  const friendly = vendor === 'Sony' ? friendlySonyModel(model) : undefined;
  const displayModel = friendly ?? model;

  if (!vendor) return { name: displayModel, model };

  // `Canon EOS R5` under make `Canon` should not become `Canon Canon EOS R5`.
  if (displayModel.toLowerCase().startsWith(`${vendor.toLowerCase()} `)) {
    return { name: `${vendor}${displayModel.slice(vendor.length)}`, make, model };
  }
  if (displayModel.toLowerCase() === vendor.toLowerCase()) {
    return { name: vendor, make, model };
  }

  return { name: `${vendor} ${displayModel}`, make, model };
}
