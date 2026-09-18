// Live responses from Building Footprints (5zhs-2jue), captured 2026-09-18.
// Query: $where=mappluto_bbl='<bbl>' OR base_bbl='<bbl>', $select=bin,base_bbl,mappluto_bbl

/** 350 5th Avenue (Empire State Building), an ordinary lot with one building. */
export const ESB = {
  bbl: '1008350041',
  rows: [{ bin: '1015862', base_bbl: '1008350041', mappluto_bbl: '1008350041' }],
};

/** 15 Central Park West, condo billing lot. base_bbl is the ground lot 1011140041. */
export const CPW15_BILLING = {
  bbl: '1011147503',
  rows: [
    { bin: '1087839', base_bbl: '1011140041', mappluto_bbl: '1011147503' },
    { bin: '1087510', base_bbl: '1011140041', mappluto_bbl: '1011147503' },
  ],
};

/** 170 East 91st Street, PLUTO class V1 (vacant), numbldgs 0. */
export const VACANT = { bbl: '1015199041', rows: [] as never[] };

/** A Bronx lot whose only footprint carries the placeholder BIN 2000000. */
export const PLACEHOLDER_ONLY = {
  bbl: '2045760018',
  rows: [{ bin: '2000000', base_bbl: '2045760018', mappluto_bbl: '2045760018' }],
};
