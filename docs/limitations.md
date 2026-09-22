# Known limitations

What the system does not do yet, and what it does instead. Each of these is
a stored, explained state, never a silent empty answer.

**Condo given as a unit BBL.** Condo apartments have their own paper lot
numbers (1001 to 6999). Violations are recorded against the building, whose
billing lot is 7501 or higher, and none of the three sources can get from a
unit lot to its building. A unit BBL is stored with
`resolution.status: "unresolved"` and the reason
`condo unit lot; send the building address or the billing-lot BBL (7501+)`.
Sending the address instead works: GeoSearch resolves unit addresses to the
building.

**GeoSearch outages.** It is a free city service and does go down (it
returned 503 all day on 2026-09-16). An address that cannot be geocoded is
stored as `resolution.status: "pending"` with the error and returns 202. The
next `POST` of the same address, or `npm run resolve:retry`, finishes it
under the same id. BBL input does not depend on GeoSearch.

**Addresses with no exact match.** GeoSearch's confidence score is a constant
0.8 and it returns a "match" for streets that do not exist, so we accept a
candidate only when house number, street and borough all match what was
sent. Anything else is stored as `resolution.status: "unresolved"` with the
reason (`no exact match …`, `ambiguous borough …`). Unresolved is not final:
the same `POST` or `npm run resolve:retry` tries again.

**Neighbourhood names.** "NY" is read as the state, never as a borough, and
a ZIP code places the address in its borough, so
"37-15 82nd Street, Jackson Heights, NY 11372" resolves. A neighbourhood with
no comma before it ("37-15 82nd Street Jackson Heights") is read as part of
the street name and comes back unresolved.

**Rows without a BIN.** About 4,600 ECB rows carry no BIN. They cannot be
attached to any property and are not served.

**Lots with no footprint.** Building Footprints has gaps (Madison Square
Garden's lot has no row). Such a lot lands `not_applicable` with the reason
`no buildings on lot (Building Footprints)`. DESIGN.md §5 has the fallback we
would add.

**Lots with no PLUTO address.** Condo unit lots have no PLUTO row at all,
and 12 of the 10,000 scale lots have a row whose address is blank. Either
way a lot registered by BBL shows `normalizedAddress: null` until an address
is sent for it.

**Lot padding.** Counting ECB rows by block and lot undercounts, because the
same lot appears as `0041` and `00041`. We join by BIN. The numbers are in
`verification.md`.

**No authentication.** `/admin/*` triggers runs and exposes the run log. In
production it would sit behind auth; out of scope here.
