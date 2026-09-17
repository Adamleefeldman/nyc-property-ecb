// BBL = Borough (1) + Block (5) + Lot (4), the 10-digit ID of a lot.
// Accepts the forms seen in the wild and returns one canonical form so that
// "the same lot" always compares equal.

export interface Bbl {
  bbl: string; // canonical 10 digits
  borough: number; // 1–5
  block: string; // 5 digits, zero-padded
  lot: string; // 4 digits, zero-padded
}

export class InvalidBblError extends Error {
  constructor(input: string, why: string) {
    super(`invalid BBL "${input}": ${why}`);
    this.name = 'InvalidBblError';
  }
}

const BOROUGH_NAMES: Record<number, string> = {
  1: 'Manhattan',
  2: 'Bronx',
  3: 'Brooklyn',
  4: 'Queens',
  5: 'Staten Island',
};

/**
 * Accepts `1008350041`, `1-00835-0041`, `1/835/41`, and PLUTO's `1008350041.00000000`.
 */
export function normalizeBbl(input: string): Bbl {
  const text = input.trim();
  if (!text) throw new InvalidBblError(input, 'empty');

  let borough: string;
  let block: string;
  let lot: string;

  const separated = /^(\d)\s*[-/]\s*(\d{1,5})\s*[-/]\s*(\d{1,4})$/.exec(text);
  const compact = /^(\d)(\d{5})(\d{4})(?:\.0+)?$/.exec(text);
  if (separated) {
    [, borough, block, lot] = separated as unknown as [string, string, string, string];
  } else if (compact) {
    [, borough, block, lot] = compact as unknown as [string, string, string, string];
  } else {
    throw new InvalidBblError(input, 'expected 10 digits or borough-block-lot');
  }

  const boroughNum = Number(borough);
  if (!(boroughNum in BOROUGH_NAMES)) {
    throw new InvalidBblError(input, `borough must be 1–5, got ${borough}`);
  }
  block = block.padStart(5, '0');
  lot = lot.padStart(4, '0');
  if (Number(block) === 0) throw new InvalidBblError(input, 'block cannot be 0');
  if (Number(lot) === 0) throw new InvalidBblError(input, 'lot cannot be 0');

  return { bbl: `${borough}${block}${lot}`, borough: boroughNum, block, lot };
}

export function boroughName(borough: number): string {
  return BOROUGH_NAMES[borough] ?? String(borough);
}

/**
 * Condo apartments carry their own paper lot in 1001–6999; the building that
 * violations are filed against sits on a billing lot 7501+. None of our sources
 * map unit lot → billing lot, so a raw unit-lot BBL cannot be resolved.
 */
export function isCondoUnitLot(lot: string): boolean {
  const n = Number(lot);
  return n >= 1001 && n <= 6999;
}

export const CONDO_UNIT_LOT_REASON =
  'condo unit lot; send the building address or the billing-lot BBL (7501+)';
