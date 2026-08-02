// edna-export.js — export a filtered, taxonomy-annotated run as a flat
// name/abundance table matching Clann eDNA Explorer's generic tab-delimited
// input format (see clann-edna-explorer/src/parsers/sniff.js sniffGeneric:
// >=2 columns, one column that's numeric in nearly every row (abundance),
// one that's text in nearly every row (taxon name), optional header — the
// header is auto-detected because a text "abundance" cell in row 1 isn't
// numeric). Two columns, "name" then "abundance", header first, satisfies
// that detector directly with no manual column mapping needed on load.
//
// One BLAST/DIAMOND run here becomes one eDNA "sample": each query stands
// in for one read, assigned to the taxon of its best hit passing the
// active filters (ties broken the same way as the rest of the app's
// "best hit" handling — highest bitscore, first one seen). A query with no
// hit passing the filters counts as "Unclassified", mirroring how a
// metabarcoding read that failed to classify is reported by Kraken/Bracken.
// Process each sample's BLAST/DIAMOND output through this exporter, then
// load all the resulting TSVs into Clann eDNA Explorer together as a
// multi-sample run.

import { filterHits } from "../src/analysis/filters.js";
import { taxonLabel } from "../src/render/taxonomy.js";
import { toDelimited } from "./table-export.js";

export const UNCLASSIFIED = "Unclassified";

/** Best available taxon name for a hit: full lineage species, else sscinames, else a stitle-parsed guess. */
function bestTaxonName(hit) {
  if (hit.taxonLineage?.species) return hit.taxonLineage.species;
  if (hit.sscinames) return String(hit.sscinames).split(";")[0].trim();
  const guess = taxonLabel(hit);
  return guess ? guess.label : null;
}

/**
 * One row per taxon: { name, abundance }, abundance = number of queries
 * whose best hit passing `thresholds` resolved to that taxon (queries with
 * no passing hit are pooled under "Unclassified"). Sorted by abundance
 * descending. `data.queries` (not just the filtered hits) drives the query
 * list, so every query is accounted for exactly once, classified or not.
 */
export function toEdnaSampleRows(data, thresholds) {
  const filtered = filterHits(data.hits, thresholds);
  const bestPerQuery = new Map();
  for (const h of filtered) {
    const cur = bestPerQuery.get(h.qseqid);
    if (!cur || (h.bitscore ?? -Infinity) > (cur.bitscore ?? -Infinity)) bestPerQuery.set(h.qseqid, h);
  }

  const counts = new Map();
  for (const q of data.queries) {
    const best = bestPerQuery.get(q.qseqid);
    const name = (best && bestTaxonName(best)) || UNCLASSIFIED;
    counts.set(name, (counts.get(name) || 0) + 1);
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, abundance]) => ({ name, abundance }));
}

/** toEdnaSampleRows(), rendered as tab-delimited text ready for download. */
export function toEdnaSampleTsv(data, thresholds) {
  return toDelimited(toEdnaSampleRows(data, thresholds), ["name", "abundance"], "\t");
}
