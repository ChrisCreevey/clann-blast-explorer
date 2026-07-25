// summary.js — per-query and global summary calculations.

/** Return the query summary row for a given qseqid (hitCount, best hit). */
export function querySummary(data, qseqid) {
  return data.queries.find((q) => q.qseqid === qseqid) || null;
}

/** All hits for a query, ranked by bitscore descending (falls back to evalue ascending). */
export function rankedHits(data, qseqid) {
  return data.hits
    .filter((h) => h.qseqid === qseqid)
    .slice()
    .sort((a, b) => {
      if (a.bitscore !== undefined && b.bitscore !== undefined) return b.bitscore - a.bitscore;
      if (a.evalue !== undefined && b.evalue !== undefined) return a.evalue - b.evalue;
      return 0;
    });
}

/** Global summary across all queries: total queries, hit counts, queries with no hit. */
export function globalSummary(data) {
  const withHits = data.queries.filter((q) => q.hitCount > 0).length;
  return {
    totalQueries: data.queries.length,
    totalHits: data.hits.length,
    queriesWithHits: withHits,
    queriesWithNoHit: data.queries.length - withHits,
  };
}

// TODO: additional analyses pending — Chris to supply further analyses used in
// teaching practice (e.g. contamination screening, identity/coverage rules of
// thumb, additional figure types) per build brief §9a.
