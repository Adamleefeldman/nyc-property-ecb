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
  MANHATTAN: 1, MN: 1, 'NEW YORK': 1, NY: 1, NYC: 1,
  BRONX: 2, 'THE BRONX': 2, BX: 2,
  BROOKLYN: 3, BK: 3, BKLYN: 3,
  QUEENS: 4, QN: 4, QNS: 4,
  'STATEN ISLAND': 5, SI: 5,
};
export const BOROUGH_NAME: Record<number, string> = {
  1: 'MANHATTAN', 2: 'BRONX', 3: 'BROOKLYN', 4: 'QUEENS', 5: 'STATEN ISLAND',
};

/** PAD spells street types out in full and writes ordinals as bare numbers. */
const STREET_WORDS: Record<string, string> = {
  AVE: 'AVENUE', AV: 'AVENUE', ST: 'STREET', STR: 'STREET', RD: 'ROAD', BLVD: 'BOULEVARD', BL: 'BOULEVARD',
  PL: 'PLACE', DR: 'DRIVE', PKWY: 'PARKWAY', PKY: 'PARKWAY', LN: 'LANE', CT: 'COURT', TER: 'TERRACE',
  TERR: 'TERRACE', HWY: 'HIGHWAY', EXPY: 'EXPRESSWAY', EXPWY: 'EXPRESSWAY', SQ: 'SQUARE', CIR: 'CIRCLE',
  N: 'NORTH', S: 'SOUTH', E: 'EAST', W: 'WEST',
};

const UNIT_RE = /\s+(?:APT|APARTMENT|UNIT|SUITE|STE|FL|FLOOR|RM|ROOM|PH|#)\.?\s*#?\s*([A-Z0-9-]+)$/;

/** Apply to both the user's street and GeoSearch's, so the comparison is symmetric. */
export function normalizeStreet(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[.,]/g, ' ')
    .replace(/\b(\d+)(?:ST|ND|RD|TH)\b/g, '$1') // 5TH → 5, 82ND → 82
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => STREET_WORDS[w] ?? w)
    .join(' ');
}

export function boroughFromText(raw: string): number | null {
  return BOROUGH_WORDS[raw.trim().toUpperCase()] ?? null;
}

export function normalizeAddress(input: string): NormalizedAddress {
  const text = input.replace(/\s+/g, ' ').trim();
  if (!text) throw new InvalidAddressError(input, 'empty');

  // "350 5th Avenue, Manhattan, NY 10001" → first part is the street address,
  // the rest may name a borough; state and zip are ignored.
  const parts = text.split(',').map((p) => p.trim()).filter(Boolean);
  let streetPart = (parts[0] ?? '').toUpperCase();
  let borough: number | null = null;
  for (const p of parts.slice(1)) {
    const b = boroughFromText(p.replace(/\s+\d{5}(-\d{4})?$/, '').replace(/\s+NY$/i, ''));
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
