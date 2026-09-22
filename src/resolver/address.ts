// Typed address → the form PAD (the city's address directory) uses, so that a
// GeoSearch candidate can be compared to what the user asked for, exactly.
// Pure: no I/O.

export interface NormalizedAddress {
  houseNumber: string; // '350', '37-15' (Queens hyphen kept), '350A'
  street: string; // '5 AVENUE', '82 STREET', 'CENTRAL PARK WEST'
  borough: number | null; // 1–5 when the text named one
  unit: string | null; // '12B' from 'Apt 12B'
  /** What we store and show: '350 5 AVENUE, MANHATTAN' (borough only when known). */
  normalized: string;
  /** Lookup key for property_inputs: normalized + unit. Same text → same key. */
  inputKey: string;
  /** What we send to GeoSearch: street address plus borough, no unit. */
  queryText: string;
}

export class InvalidAddressError extends Error {
  constructor(input: string, why: string) {
    super(`invalid address "${input}": ${why}`);
    this.name = 'InvalidAddressError';
  }
}

const BOROUGH_WORDS: Record<string, number> = {
  MANHATTAN: 1, MN: 1, 'NEW YORK': 1,
  BRONX: 2, 'THE BRONX': 2, BX: 2,
  BROOKLYN: 3, BK: 3, BKLYN: 3,
  QUEENS: 4, QN: 4, QNS: 4,
  'STATEN ISLAND': 5, SI: 5,
};
export const BOROUGH_NAME: Record<number, string> = {
  1: 'MANHATTAN', 2: 'BRONX', 3: 'BROOKLYN', 4: 'QUEENS', 5: 'STATEN ISLAND',
};

/** PAD spells street types out in full and writes ordinals as bare numbers. */
const STREET_TYPES: Record<string, string> = {
  AVE: 'AVENUE', AV: 'AVENUE', ST: 'STREET', STR: 'STREET', RD: 'ROAD', BLVD: 'BOULEVARD', BL: 'BOULEVARD',
  PL: 'PLACE', DR: 'DRIVE', PKWY: 'PARKWAY', PKY: 'PARKWAY', LN: 'LANE', CT: 'COURT', TER: 'TERRACE',
  TERR: 'TERRACE', HWY: 'HIGHWAY', EXPY: 'EXPRESSWAY', EXPWY: 'EXPRESSWAY', SQ: 'SQUARE', CIR: 'CIRCLE',
};
/** "ST NICHOLAS AVENUE", "DR MARTIN LUTHER KING JR BOULEVARD": Saint and Doctor unless they end the name. */
const END_ONLY_TYPES = new Set(['ST', 'DR']);
const DIRECTIONS: Record<string, string> = { N: 'NORTH', S: 'SOUTH', E: 'EAST', W: 'WEST' };

/**
 * Expand an abbreviation only in the position where it means that: a type
 * anywhere (except ST/DR, which are Saint/Doctor unless last), a direction as
 * a prefix ("W 4 STREET") or, on a longer name, a suffix ("PARK AVENUE SOUTH").
 * Two-word "AVENUE N" is one of Brooklyn's lettered avenues and stays as is.
 */
function expandWord(w: string, i: number, n: number): string {
  const last = i === n - 1;
  const type = STREET_TYPES[w];
  if (type && (last || !END_ONLY_TYPES.has(w))) return type;
  const dir = DIRECTIONS[w];
  if (dir && (i === 0 || (last && n > 2))) return dir;
  return w;
}

const UNIT_RE = /\s+(?:APT|APARTMENT|UNIT|SUITE|STE|FL|FLOOR|RM|ROOM|PH|#)\.?\s*#?\s*([A-Z0-9-]+)$/;

// Spelled-out ordinals: "Fifth Avenue", "West Forty-Second Street",
// "One Hundred Twenty-Fifth Street". A run of number words that ends in an
// ordinal word becomes the number; anything else is left alone.
const CARDINAL: Record<string, number> = {
  ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5, SIX: 6, SEVEN: 7, EIGHT: 8, NINE: 9, TEN: 10,
  ELEVEN: 11, TWELVE: 12, THIRTEEN: 13, FOURTEEN: 14, FIFTEEN: 15, SIXTEEN: 16, SEVENTEEN: 17,
  EIGHTEEN: 18, NINETEEN: 19, TWENTY: 20, THIRTY: 30, FORTY: 40, FIFTY: 50, SIXTY: 60,
  SEVENTY: 70, EIGHTY: 80, NINETY: 90, HUNDRED: 100,
};
const ORDINAL: Record<string, number> = {
  FIRST: 1, SECOND: 2, THIRD: 3, FOURTH: 4, FIFTH: 5, SIXTH: 6, SEVENTH: 7, EIGHTH: 8, NINTH: 9, TENTH: 10,
  ELEVENTH: 11, TWELFTH: 12, THIRTEENTH: 13, FOURTEENTH: 14, FIFTEENTH: 15, SIXTEENTH: 16, SEVENTEENTH: 17,
  EIGHTEENTH: 18, NINETEENTH: 19, TWENTIETH: 20, THIRTIETH: 30, FORTIETH: 40, FIFTIETH: 50, SIXTIETH: 60,
  SEVENTIETH: 70, EIGHTIETH: 80, NINETIETH: 90, HUNDREDTH: 100,
};

function wordsToNumber(words: string[]): number | null {
  const last = words[words.length - 1]!;
  if (!(last in ORDINAL)) return null;
  let n = 0;
  for (const w of words) {
    const v = CARDINAL[w] ?? ORDINAL[w]!;
    n = v === 100 ? (n || 1) * 100 : n + v;
  }
  return n;
}

function collapseNumberWords(tokens: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; ) {
    let j = i;
    while (j < tokens.length && (tokens[j]! in CARDINAL || tokens[j]! in ORDINAL)) j += 1;
    const n = j > i ? wordsToNumber(tokens.slice(i, j)) : null;
    if (n !== null) {
      out.push(String(n));
      i = j;
    } else {
      out.push(tokens[i]!);
      i += 1;
    }
  }
  return out;
}

/** Apply to both the user's street and GeoSearch's, so the comparison is symmetric. */
export function normalizeStreet(raw: string): string {
  const tokens = raw
    .toUpperCase()
    .replace(/[.,]/g, ' ')
    .replace(/\b(\d+)(?:ST|ND|RD|TH)\b/g, '$1') // 5TH → 5, 82ND → 82
    .replace(/(?<=[A-Z])-(?=[A-Z])/g, ' ') // FORTY-SECOND → FORTY SECOND (digit hyphens untouched)
    .split(/\s+/)
    .filter(Boolean);
  const words = collapseNumberWords(tokens);
  return words.map((w, i) => expandWord(w, i, words.length)).join(' ');
}

export function boroughFromText(raw: string): number | null {
  return BOROUGH_WORDS[raw.trim().toUpperCase()] ?? null;
}

/**
 * NYC ZIP prefixes are borough-specific: 100–102 Manhattan, 103 Staten Island,
 * 104 Bronx, 112 Brooklyn, 111/113/114/116 Queens. 110xx and 115xx straddle
 * the Nassau County line, so they say nothing.
 */
const ZIP_PREFIX_BOROUGH: Record<string, number> = {
  100: 1, 101: 1, 102: 1, 103: 5, 104: 2, 111: 4, 112: 3, 113: 4, 114: 4, 116: 4,
};
function boroughFromZip(zip: string): number | null {
  return ZIP_PREFIX_BOROUGH[zip.slice(0, 3)] ?? null;
}

export function normalizeAddress(input: string): NormalizedAddress {
  const text = input.replace(/\s+/g, ' ').trim();
  if (!text) throw new InvalidAddressError(input, 'empty');

  // "350 5th Avenue, Manhattan, NY 10001": the first part is the street
  // address; later parts may name the borough. "NY" is the state, never a
  // borough. "New York" is Manhattan by postal convention but is also the
  // state's name, so a ZIP outranks it ("Jackson Heights, New York 11372").
  // Neighbourhood names are not understood; the ZIP is what places them.
  const parts = text.split(',').map((p) => p.trim()).filter(Boolean);
  let streetPart = (parts[0] ?? '').toUpperCase();
  let borough: number | null = null;
  let zipBorough: number | null = null;
  let sawNewYork = false;
  for (const p of parts.slice(1)) {
    const zip = /(\d{5})(?:-\d{4})?$/.exec(p)?.[1];
    if (zip && zipBorough === null) zipBorough = boroughFromZip(zip);
    const word = p.replace(/\s*\d{5}(?:-\d{4})?$/, '').replace(/(?:^|\s)NY$/i, '').trim().toUpperCase();
    if (word === 'NEW YORK') { sawNewYork = true; continue; }
    const b = word ? boroughFromText(word) : null;
    if (b) { borough = b; break; }
  }
  // A trailing borough word with no comma: "350 5th Avenue Manhattan".
  if (borough === null) {
    for (const [word, num] of Object.entries(BOROUGH_WORDS)) {
      if (word.length > 2 && streetPart.endsWith(' ' + word)) {
        borough = num;
        streetPart = streetPart.slice(0, -word.length).trim();
        break;
      }
    }
  }
  if (borough === null) borough = zipBorough ?? (sawNewYork ? 1 : null);

  let unit: string | null = null;
  const unitMatch = UNIT_RE.exec(streetPart);
  if (unitMatch) {
    unit = unitMatch[1]!;
    streetPart = streetPart.slice(0, unitMatch.index).trim();
  }

  // House number: digits, an optional Queens hyphen part, an optional letter suffix.
  const hn = /^(\d+(?:-\d+)?[A-Z]?)\s+(.+)$/.exec(streetPart);
  if (!hn) throw new InvalidAddressError(input, 'needs a house number followed by a street');
  const houseNumber = hn[1]!;
  const street = normalizeStreet(hn[2]!);
  if (!street) throw new InvalidAddressError(input, 'needs a street name');

  const normalized = borough ? `${houseNumber} ${street}, ${BOROUGH_NAME[borough]}` : `${houseNumber} ${street}`;
  return {
    houseNumber,
    street,
    borough,
    unit,
    normalized,
    inputKey: unit ? `${normalized} #${unit}` : normalized,
    queryText: normalized,
  };
}
