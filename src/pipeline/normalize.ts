// Raw ECB row (every field a string) → typed record. Pure: no I/O, so
// `npm run renormalize` can rebuild the normalized table from raw alone.

import { createHash } from 'node:crypto';

/** Column names match the ecb_violations table so rows can be inserted as-is. */
export interface NormalizedViolation {
  ecb_violation_number: string;
  bin: string | null;
  bbl: string | null;
  borough: number | null;
  block: string | null;
  lot: string | null;
  status: string | null;
  issue_date: string | null; // YYYY-MM-DD
  served_date: string | null;
  hearing_date: string | null;
  hearing_status: string | null;
  certification_status: string | null;
  severity: string | null;
  violation_type: string | null;
  violation_description: string | null;
  respondent_name: string | null;
  penalty_imposed: string | null; // decimal as text; Postgres NUMERIC takes it exactly
  amount_paid: string | null;
  balance_due: string | null;
  dob_violation_number: string | null;
  infraction_code: string | null;
  section_law_description: string | null;
  aggravated_level: string | null;
  content_hash: string;
}

export type RawViolation = Record<string, string | undefined>;

const text = (v: string | undefined): string | null => {
  const t = v?.trim().replace(/\s+/g, ' ');
  return t ? t : null;
};

/** `20090605` → `2009-06-05`; anything that is not a real calendar date → null. */
export function parseYyyymmdd(v: string | undefined): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(v?.trim() ?? '');
  if (!m) return null;
  const [, y, mo, d] = m as unknown as [string, string, string, string];
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  const roundTrips =
    date.getUTCFullYear() === Number(y) && date.getUTCMonth() === Number(mo) - 1 && date.getUTCDate() === Number(d);
  return roundTrips ? `${y}-${mo}-${d}` : null;
}

/** `"500"`, `"-1250.5"`, `"1,000"` → decimal text with two places; junk → null. Negatives kept. */
export function parseMoney(v: string | undefined): string | null {
  const cleaned = v?.trim().replace(/[$,]/g, '') ?? '';
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  return Number(cleaned).toFixed(2);
}

function padDigits(v: string | undefined, width: number): string | null {
  const digits = v?.trim() ?? '';
  if (!/^\d+$/.test(digits) || digits.length > width) return null;
  return digits.padStart(width, '0');
}

/** Returns null when the row has no violation number: nothing to key it on. */
export function normalizeViolation(raw: RawViolation): NormalizedViolation | null {
  const ecbViolationNumber = text(raw.ecb_violation_number);
  if (!ecbViolationNumber) return null;

  const boroughNum = Number(raw.boro?.trim());
  const borough = Number.isInteger(boroughNum) && boroughNum >= 1 && boroughNum <= 5 ? boroughNum : null;
  const block = padDigits(raw.block, 5);
  const lot = padDigits(raw.lot, 4);
  const bbl = borough && block && lot && Number(block) > 0 && Number(lot) > 0 ? `${borough}${block}${lot}` : null;

  const fields = {
    ecb_violation_number: ecbViolationNumber,
    bin: text(raw.bin),
    bbl,
    borough,
    block,
    lot,
    status: text(raw.ecb_violation_status),
    issue_date: parseYyyymmdd(raw.issue_date),
    served_date: parseYyyymmdd(raw.served_date),
    hearing_date: parseYyyymmdd(raw.hearing_date),
    hearing_status: text(raw.hearing_status),
    certification_status: text(raw.certification_status),
    severity: text(raw.severity),
    violation_type: text(raw.violation_type),
    violation_description: text(raw.violation_description),
    respondent_name: text(raw.respondent_name),
    penalty_imposed: parseMoney(raw.penality_imposed), // sic: the source misspells it
    amount_paid: parseMoney(raw.amount_paid),
    balance_due: parseMoney(raw.balance_due),
    dob_violation_number: text(raw.dob_violation_number),
    infraction_code: text(raw.infraction_code1),
    section_law_description: text(raw.section_law_description1),
    aggravated_level: text(raw.aggravated_level),
  };

  // Hash of the values we serve. The store bumps updated_at only when it changes.
  const content_hash = createHash('sha256').update(JSON.stringify(fields)).digest('hex').slice(0, 32);
  return { ...fields, content_hash };
}
