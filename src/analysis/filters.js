// filters.js — threshold/taxon filtering logic for the across-queries view.

export function defaultThresholds() {
  return {
    minPident: 0,
    maxEvalue: null, // null = no cap
    minBitscore: 0,
    minLength: 0,
    minQcov: 0,
    excludeSelfHits: false,
    topNPerQuery: 0, // 0 = no cap
    taxonInclude: "", // comma-separated scientific names/substrings
    taxonExclude: "",
    taxonRank: "any", // "any" (name/common-name/staxid text), or a specific lineage rank — see LINEAGE_RANKS in ../analysis/taxonomy-db.js
  };
}

/** Query coverage for a hit: uses qcovs/qcovhsp if present, else derives from qlen and the aligned span. */
export function computeQcov(hit) {
  if (typeof hit.qcovs === "number") return hit.qcovs;
  if (typeof hit.qcovhsp === "number") return hit.qcovhsp;
  if (typeof hit.qlen === "number" && hit.qlen > 0 && hit.qstart !== undefined && hit.qend !== undefined) {
    const span = Math.abs(hit.qend - hit.qstart) + 1;
    return Math.min(100, (span / hit.qlen) * 100);
  }
  return undefined;
}

function taxonNamesOf(hit, rank) {
  // A specific lineage rank (e.g. "phylum") only matches against that rank's
  // resolved name — set on the hit by enrichHitsWithLineage when the
  // built-in taxonomy database (../analysis/taxonomy-db.js) was applied.
  // Hits without lineage data (manual names.dmp upload, or no taxonomy
  // applied at all) simply never match a rank-specific filter.
  if (rank && rank !== "any") {
    const v = hit.taxonLineage?.[rank];
    return v ? String(v).toLowerCase() : "";
  }
  const names = [];
  if (hit.sscinames) names.push(hit.sscinames);
  if (hit.scomnames) names.push(hit.scomnames);
  if (hit.staxids) names.push(...(Array.isArray(hit.staxids) ? hit.staxids : [hit.staxids]));
  return names.join(" ").toLowerCase();
}

function matchesTaxonList(hit, list, rank) {
  if (!list) return null; // no constraint
  const terms = list.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!terms.length) return null;
  const haystack = taxonNamesOf(hit, rank);
  return terms.some((t) => haystack.includes(t));
}

/** Does a single hit pass the numeric/taxon thresholds (ignores self-hit/top-N, which are query-level)? */
export function passesThresholds(hit, thresholds) {
  const t = thresholds;
  if (t.minPident && (hit.pident === undefined || hit.pident < t.minPident)) return false;
  if (t.maxEvalue !== null && t.maxEvalue !== undefined && hit.evalue !== undefined && hit.evalue > t.maxEvalue) return false;
  if (t.minBitscore && (hit.bitscore === undefined || hit.bitscore < t.minBitscore)) return false;
  if (t.minLength && (hit.length === undefined || hit.length < t.minLength)) return false;
  if (t.minQcov) {
    const qcov = computeQcov(hit);
    if (qcov === undefined || qcov < t.minQcov) return false;
  }
  if (t.excludeSelfHits && hit.qseqid === hit.sseqid) return false;
  if (t.taxonInclude && matchesTaxonList(hit, t.taxonInclude, t.taxonRank) === false) return false;
  if (t.taxonExclude && matchesTaxonList(hit, t.taxonExclude, t.taxonRank) === true) return false;
  return true;
}

/** Filter the full hit list, then apply the per-query top-N cap (by bitscore desc, falling back to evalue asc). */
export function filterHits(hits, thresholds) {
  let filtered = hits.filter((h) => passesThresholds(h, thresholds));
  if (thresholds.topNPerQuery > 0) {
    const byQuery = new Map();
    for (const h of filtered) {
      if (!byQuery.has(h.qseqid)) byQuery.set(h.qseqid, []);
      byQuery.get(h.qseqid).push(h);
    }
    filtered = [];
    for (const list of byQuery.values()) {
      list.sort((a, b) => {
        if (a.bitscore !== undefined && b.bitscore !== undefined) return b.bitscore - a.bitscore;
        if (a.evalue !== undefined && b.evalue !== undefined) return a.evalue - b.evalue;
        return 0;
      });
      filtered.push(...list.slice(0, thresholds.topNPerQuery));
    }
  }
  return filtered;
}

/** 'hit' (has a hit passing thresholds), 'weak' (has hits but none pass), or 'none' (no hits at all). */
export function classifyQuery(allQueryHits, filteredQueryHits) {
  if (filteredQueryHits.length > 0) return "hit";
  if (allQueryHits.length > 0) return "weak";
  return "none";
}
