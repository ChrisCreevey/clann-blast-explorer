// rbh.js — reciprocal best hit computation.
// TODO: Phase 3. Takes two ExplorerData objects (forward/reverse runs) and
// produces a derived RBH structure: reciprocal / one-way / no-hit
// classification per query, under the currently active thresholds.
// The RBH pair table must use accessionLinkUrl() from ../parse/accession.js
// for both partner columns (see src/render/hit-table.js for the pattern),
// same as the per-query hit table — no dead links for local/assembly IDs.
