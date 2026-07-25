// rbh.js — reciprocal best hit computation.
//
// Takes two ExplorerData objects (forward and reverse runs) and produces a
// derived RBH structure. Deliberately kept separate from ExplorerData: RBH is
// a relationship between two independent runs, not a property of either one.

import { filterHits } from "./filters.js";

function stripVersion(id) {
  return String(id).replace(/\.\d+$/, "");
}

/** Best (highest-bitscore) hit passing thresholds per qseqid, plus a version-stripped lookup index. */
function bestHitsByQuery(hits, thresholds) {
  const filtered = filterHits(hits, thresholds);
  const byExact = new Map();
  for (const h of filtered) {
    const cur = byExact.get(h.qseqid);
    if (!cur || (h.bitscore ?? -Infinity) > (cur.bitscore ?? -Infinity)) byExact.set(h.qseqid, h);
  }
  const byStripped = new Map();
  for (const [id, h] of byExact) {
    const s = stripVersion(id);
    if (!byStripped.has(s)) byStripped.set(s, h);
  }
  return { byExact, byStripped };
}

function lookup(index, id) {
  return index.byExact.get(id) || index.byStripped.get(stripVersion(id));
}

function idsMatch(a, b) {
  return a === b || stripVersion(a) === stripVersion(b);
}

/**
 * Classify every forward-run query as 'reciprocal' (its best hit's best hit
 * points back to it), 'one-way' (has a best hit, but it doesn't reciprocate),
 * or 'no-hit' (no hit passes thresholds at all) — under the active thresholds.
 */
export function computeRBH(forward, reverse, thresholds) {
  const fwdIndex = bestHitsByQuery(forward.hits, thresholds);
  const revIndex = bestHitsByQuery(reverse.hits, thresholds);

  const classification = [];
  const pairs = [];

  for (const query of forward.queries) {
    const fwdBest = fwdIndex.byExact.get(query.qseqid);
    if (!fwdBest) {
      classification.push({ qseqid: query.qseqid, status: "no-hit", fwdBest: null, revBest: null });
      continue;
    }
    const revBest = lookup(revIndex, fwdBest.sseqid);
    const reciprocal = !!revBest && idsMatch(revBest.sseqid, query.qseqid);
    classification.push({
      qseqid: query.qseqid,
      status: reciprocal ? "reciprocal" : "one-way",
      partner: fwdBest.sseqid,
      fwdBest,
      revBest: revBest || null,
    });
    if (reciprocal) {
      pairs.push({ qseqid: query.qseqid, partner: fwdBest.sseqid, fwdBest, revBest });
    }
  }

  const counts = {
    reciprocal: classification.filter((c) => c.status === "reciprocal").length,
    oneWay: classification.filter((c) => c.status === "one-way").length,
    noHit: classification.filter((c) => c.status === "no-hit").length,
  };

  return { classification, pairs, counts };
}
