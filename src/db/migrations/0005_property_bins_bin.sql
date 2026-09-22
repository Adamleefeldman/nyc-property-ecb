-- The cross-property scan (GET /ecb-violations) maps each violation back to
-- its properties by BIN. The primary key (property_id, bin) cannot serve a
-- lookup by bin alone, so without this index every row on a page scanned the
-- whole table (1.5 s per 500-row page at 10,000 properties).
CREATE INDEX property_bins_bin_idx ON property_bins (bin);
