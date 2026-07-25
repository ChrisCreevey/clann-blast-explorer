// summary.js — per-query and global summary calculations.

import { filterHits, classifyQuery } from "./filters.js";

/**
 * All hits tied for the top bit score in `hits` (length 1 when there's a
 * single clear best, longer when several hits share the same top score —
 * "best hit" is otherwise just whichever tied hit happens to appear first).
 */
export function bestHits(hits) {
  if (!hits.length) return [];
  const maxBitscore = Math.max(...hits.map((h) => h.bitscore ?? -Infinity));
  return hits.filter((h) => (h.bitscore ?? -Infinity) === maxBitscore);
}

/**
 * Per-query summary rows under the active thresholds: hit count, best hit(s)
 * (both unfiltered and filtered), and a hit/weak/none flag. Used by the
 * across-queries summary table. `bestTied` holds every hit tied for the top
 * bit score; `best` is bestTied[0], kept for call sites that just want one.
 */
export function perQuerySummary(data, thresholds) {
  const filtered = filterHits(data.hits, thresholds);
  const filteredByQuery = new Map();
  for (const h of filtered) {
    if (!filteredByQuery.has(h.qseqid)) filteredByQuery.set(h.qseqid, []);
    filteredByQuery.get(h.qseqid).push(h);
  }
  return data.queries.map((q) => {
    const allHits = data.hits.filter((h) => h.qseqid === q.qseqid);
    const passingHits = filteredByQuery.get(q.qseqid) || [];
    const bestTied = bestHits(passingHits);
    return {
      qseqid: q.qseqid,
      hitCount: allHits.length,
      passingCount: passingHits.length,
      best: bestTied[0] || q.best,
      bestTied: bestTied.length ? bestTied : (q.best ? [q.best] : []),
      flag: classifyQuery(allHits, passingHits),
    };
  });
}

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
