// index.js — detectFormat() + parse(): turns uploaded BLAST/DIAMOND tabular text into ExplorerData.
//
// ExplorerData is the single internal shape every renderer consumes (see build brief §4).

import { parseBlastTabular } from "./blast-tabular.js";

export class ColumnMappingNeeded extends Error {
  constructor(message, { rawFirstRow } = {}) {
    super(message);
    this.name = "ColumnMappingNeeded";
    this.rawFirstRow = rawFirstRow;
  }
}

function buildQueries(hits) {
  const byQuery = new Map();
  for (const hit of hits) {
    const id = hit.qseqid;
    if (!byQuery.has(id)) byQuery.set(id, { qseqid: id, hits: [], best: null });
    const q = byQuery.get(id);
    q.hits.push(hit);
    if (!q.best || (hit.bitscore ?? -Infinity) > (q.best.bitscore ?? -Infinity)) q.best = hit;
  }
  return [...byQuery.values()].map((q) => ({
    qseqid: q.qseqid,
    hitCount: q.hits.length,
    best: q.best,
  }));
}

/**
 * Parse uploaded tabular text (and optional manual column mapping) into ExplorerData.
 * @param {string} text
 * @param {{ filename?: string, columns?: string[] }} opts
 */
export function parse(text, opts = {}) {
  let format, columns, hits;
  try {
    ({ format, columns, hits } = parseBlastTabular(text, opts));
  } catch (err) {
    if (opts.columns) throw err; // manual mapping was already tried and still failed
    const rawFirstRow = text.split(/\r?\n/).find((l) => l.trim() && !l.startsWith("#"));
    throw new ColumnMappingNeeded(err.message, { rawFirstRow: rawFirstRow ? rawFirstRow.split("\t") : [] });
  }

  const hasTaxonomy = hits.some((h) => h.staxids || h.sscinames);
  const hasSequences = hits.some((h) => h.qseq || h.sseq);

  return {
    meta: {
      sourceFilename: opts.filename || null,
      format,
      columns,
      hasTaxonomy,
      hasSequences,
    },
    hits,
    queries: buildQueries(hits),
  };
}

export { STANDARD_12 } from "./blast-tabular.js";
