// fasta-export.js — FASTA subset export (query/subject/combined).

import { matchFastaIds, toFastaText } from "../src/parse/fasta.js";

/** One FASTA entry per query with a qseq column, first hit encountered wins. */
export function querySeqEntriesFromHits(hits) {
  const seen = new Map();
  for (const h of hits) {
    if (h.qseq && !seen.has(h.qseqid)) seen.set(h.qseqid, h.qseq);
  }
  return [...seen.entries()].map(([id, seq]) => ({ id, seq }));
}

/** One FASTA entry per hit row with an sseq column (a subject can appear more than once, against different queries). */
export function subjectSeqEntriesFromHits(hits) {
  return hits.filter((h) => h.sseq).map((h) => ({ id: h.sseqid, seq: h.sseq }));
}

/**
 * Build a FASTA subset from uploaded FASTA records, ID-matched against `ids`
 * (exact match, falling back to version-suffix-stripped match).
 * Returns { entries, unmatched } — unmatched is the list of ids with no match.
 */
export function matchedFastaEntries(records, ids) {
  const { matched, unmatched } = matchFastaIds(records, ids);
  const seen = new Set();
  const entries = [];
  for (const id of ids) {
    const rec = matched.get(id);
    if (rec && !seen.has(rec.id)) {
      seen.add(rec.id);
      entries.push({ id: rec.id, seq: rec.seq });
    }
  }
  return { entries, unmatched };
}

export function toFasta(entries) {
  return toFastaText(entries);
}

/** Plain accession list (one per line) — for cases where sequences aren't locally available (e.g. NCBI Batch Entrez). */
export function accessionListText(ids) {
  return ids.join("\n") + "\n";
}
