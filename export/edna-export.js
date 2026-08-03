// edna-export.js — export a filtered, taxonomy-annotated run as a "Lineage
// TSV" table for Clann eDNA Explorer: one row per unique resolved taxon
// path, carrying the full lineage (name + taxid per rank) rather than a
// flat name/count pair, so eDNA Explorer's importer can build a proper
// taxonomy tree from it — full rank views, sunburst, Sankey, and
// multi-sample comparison, the same as a native Kraken/Bracken sample.
//
// One BLAST/DIAMOND run here becomes one eDNA "sample": each query stands
// in for one read, assigned to the taxon of its best hit passing the
// active filters (ties broken the same way as the rest of the app's
// "best hit" handling — highest bitscore, first one seen). A query with no
// hit passing the filters, or whose best hit has no resolvable taxon name
// at all, counts as unclassified (a single reserved row with every rank
// column empty), mirroring how Kraken/Bracken report unclassified reads.
// Process each sample's BLAST/DIAMOND output through this exporter, then
// load all the resulting TSVs into Clann eDNA Explorer together as a
// multi-sample run.

import { filterHits } from "../src/analysis/filters.js";
import { taxonLabel } from "../src/render/taxonomy.js";
import { LINEAGE_RANKS } from "../src/analysis/taxonomy-db.js";
import { toDelimited } from "./table-export.js";

const COLUMNS = ["count", ...LINEAGE_RANKS.flatMap((r) => [r, `${r}_taxid`])];

/**
 * The ordered list of resolved { rank, name, taxid } entries for a hit's
 * taxon, root-to-leaf. Prefers the full lineage attached by
 * ../src/analysis/taxonomy-db.js's enrichHitsWithLineage (built-in taxonomy
 * database); falls back to whatever flat taxonomy the hit itself carries —
 * an `sskingdoms` column (NCBI's true superkingdom: Bacteria/Archaea/
 * Eukaryota/Viruses) as superkingdom, and `sscinames` (or a stitle-parsed
 * guess) as species, each with no taxid — a valid, if gapped/minimal, pair
 * of Lineage TSV rank columns per that format's spec (a row need not fill
 * every rank). Deliberately does *not* use `sblastnames` here: BLAST's
 * "BLAST name" is an informal, curated grouping (e.g. "rodents",
 * "eudicots") that sits at no consistent Linnaean rank, so there's no
 * canonical LINEAGE_RANKS slot to put it in — it still feeds the "any"-mode
 * taxon filter (see ../src/analysis/filters.js), just not this export.
 * Empty array means no taxon could be resolved at all.
 */
function lineagePathFor(hit) {
  if (hit.taxonLineage) {
    const path = [];
    for (const rank of LINEAGE_RANKS) {
      const name = hit.taxonLineage[rank];
      if (name) path.push({ rank, name, taxid: hit.taxonLineage[`${rank}_taxid`] });
    }
    if (path.length) return path;
  }

  const path = [];
  if (hit.sskingdoms) {
    path.push({ rank: "superkingdom", name: String(hit.sskingdoms).split(";")[0].trim(), taxid: undefined });
  }
  let speciesName = null;
  if (hit.sscinames) speciesName = String(hit.sscinames).split(";")[0].trim();
  else {
    const guess = taxonLabel(hit);
    if (guess) speciesName = guess.label;
  }
  if (speciesName) path.push({ rank: "species", name: speciesName, taxid: undefined });
  return path;
}

/**
 * One row per unique resolved taxon path: { count, <rank>, <rank>_taxid, ... }
 * (only the ranks present in that path are set; the rest are left
 * undefined, i.e. blank in the exported TSV). `count` = number of queries
 * whose best passing hit resolved to that exact path. A single trailing
 * row with only `count` set (every rank column blank) represents
 * unclassified queries, present only when that count is nonzero. Sorted by
 * count descending.
 */
export function toEdnaSampleRows(data, thresholds) {
  const filtered = filterHits(data.hits, thresholds);
  const bestPerQuery = new Map();
  for (const h of filtered) {
    const cur = bestPerQuery.get(h.qseqid);
    if (!cur || (h.bitscore ?? -Infinity) > (cur.bitscore ?? -Infinity)) bestPerQuery.set(h.qseqid, h);
  }

  const byPath = new Map(); // pathKey -> { count, path }
  let unclassifiedCount = 0;
  for (const q of data.queries) {
    const best = bestPerQuery.get(q.qseqid);
    const path = best ? lineagePathFor(best) : [];
    if (!path.length) {
      unclassifiedCount++;
      continue;
    }
    const key = path.map((p) => `${p.rank}:${p.name}`).join("|");
    const entry = byPath.get(key);
    if (entry) entry.count++;
    else byPath.set(key, { count: 1, path });
  }

  const rows = [...byPath.values()].map(({ count, path }) => {
    const row = { count };
    for (const { rank, name, taxid } of path) {
      row[rank] = name;
      if (taxid !== undefined) row[`${rank}_taxid`] = taxid;
    }
    return row;
  });
  if (unclassifiedCount > 0) rows.push({ count: unclassifiedCount });

  rows.sort((a, b) => b.count - a.count);
  return rows;
}

/** toEdnaSampleRows(), rendered as the Lineage TSV text described above, ready for download. */
export function toEdnaSampleTsv(data, thresholds) {
  return toDelimited(toEdnaSampleRows(data, thresholds), COLUMNS, "\t");
}
