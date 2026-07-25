// taxdump.js — NCBI taxonomy dump support: extract names.dmp from a
// taxdump.tar.gz (or accept it directly), parse taxid -> name, and use it to
// backfill sscinames/scomnames on hits that have a taxon ID but no name yet.
//
// Taxon ID source is configurable: the hit's own `staxids` column (the
// common case when BLAST was run with a local taxdb), or extracted from
// `sseqid` itself via a delimiter/regex (e.g. STRING/EggNOG-style
// "9606.ENSP00000269305" IDs, where the taxid is a genuine prefix).

/** Parse the raw bytes of a (decompressed) tar stream into a flat file list: [{ name, start, size }]. */
export function parseTarEntries(bytes) {
  const decoder = new TextDecoder();
  const entries = [];
  let offset = 0;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    const nameBytes = header.subarray(0, 100);
    let nameEnd = nameBytes.indexOf(0);
    if (nameEnd === -1) nameEnd = nameBytes.length;
    const name = decoder.decode(nameBytes.subarray(0, nameEnd));
    if (!name) break; // reached the archive's trailing zero blocks
    const sizeStr = decoder.decode(header.subarray(124, 136)).replace(/\0/g, "").trim();
    const size = parseInt(sizeStr, 8) || 0;
    const dataStart = offset + 512;
    entries.push({ name, start: dataStart, size });
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}

/** Gunzip + untar an NCBI taxdump archive (ArrayBuffer) and return names.dmp's text content. */
export async function extractNamesDmpFromTarGz(arrayBuffer) {
  const stream = new Blob([arrayBuffer]).stream().pipeThrough(new DecompressionStream("gzip"));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  const entries = parseTarEntries(bytes);
  const target = entries.find((e) => e.name.split("/").pop() === "names.dmp");
  if (!target) throw new Error('No "names.dmp" found inside the archive.');
  return new TextDecoder().decode(bytes.subarray(target.start, target.start + target.size));
}

/**
 * Parse NCBI's names.dmp (pipe-delimited: taxid | name | unique_name | name_class |).
 * Returns Map(taxid -> { sciName, comName }), keeping scientific names and the
 * best available common name, ignoring synonyms and other name classes.
 */
export function parseNamesDmp(text) {
  const map = new Map();
  for (const line of text.split("\n")) {
    if (!line) continue;
    const parts = line.split("|").map((s) => s.trim());
    if (parts.length < 4) continue;
    const [taxid, name, , nameClass] = parts;
    if (nameClass === "scientific name") {
      const entry = map.get(taxid) || {};
      entry.sciName = name;
      map.set(taxid, entry);
    } else if (nameClass === "genbank common name" || nameClass === "common name") {
      const entry = map.get(taxid) || {};
      if (!entry.comName || nameClass === "genbank common name") entry.comName = name;
      map.set(taxid, entry);
    }
  }
  return map;
}

/**
 * Extract a candidate taxon ID from a raw ID string using a pattern:
 * { type: "delimiter", delimiter } — the numeric prefix before the first
 * occurrence of `delimiter`; or { type: "regex", source } — the first capture
 * group of a regex. Returns null if nothing plausible is found.
 */
export function extractTaxidFromId(id, pattern) {
  if (!id || !pattern) return null;
  if (pattern.type === "delimiter") {
    const idx = id.indexOf(pattern.delimiter);
    if (idx <= 0) return null;
    const candidate = id.slice(0, idx);
    return /^\d+$/.test(candidate) ? candidate : null;
  }
  if (pattern.type === "regex") {
    let re;
    try { re = new RegExp(pattern.source); } catch { return null; }
    const m = re.exec(id);
    return m && m[1] && /^\d+$/.test(m[1]) ? m[1] : null;
  }
  return null;
}

/** Candidate taxon ID(s) for a hit under the given source config. */
function taxonIdsFor(hit, source) {
  if (source.mode === "staxids") {
    if (!hit.staxids) return [];
    return Array.isArray(hit.staxids) ? hit.staxids : [hit.staxids];
  }
  if (source.mode === "pattern") {
    const id = extractTaxidFromId(hit.sseqid, source.pattern);
    return id ? [id] : [];
  }
  return [];
}

/**
 * Preview what a source config would resolve, for the first few distinct
 * sseqids — shown to the user before applying, since a pattern-extracted ID
 * can coincidentally match an unrelated real taxon (a false positive with no
 * other way to catch it).
 */
export function buildTaxonPreview(hits, taxonMap, source, limit = 8) {
  const seen = new Set();
  const rows = [];
  for (const h of hits) {
    if (rows.length >= limit) break;
    if (seen.has(h.sseqid)) continue;
    seen.add(h.sseqid);
    const ids = taxonIdsFor(h, source);
    const names = ids.map((id) => taxonMap.get(id)?.sciName).filter(Boolean);
    rows.push({ sseqid: h.sseqid, extractedIds: ids, names });
  }
  return rows;
}

/**
 * Backfill sscinames/scomnames on hits that have a resolvable taxon ID but no
 * name yet. Never overwrites an existing sscinames. Returns a new hits array
 * (originals untouched) and the count of hits that were filled in.
 */
export function enrichHitsWithTaxonomy(hits, taxonMap, source) {
  let filledCount = 0;
  const enriched = hits.map((h) => {
    if (h.sscinames) return h;
    const ids = taxonIdsFor(h, source);
    if (!ids.length) return h;
    const names = ids.map((id) => taxonMap.get(id)?.sciName).filter(Boolean);
    if (!names.length) return h;
    const comNames = ids.map((id) => taxonMap.get(id)?.comName).filter(Boolean);
    filledCount++;
    return {
      ...h,
      sscinames: names.join("; "),
      ...(comNames.length ? { scomnames: comNames.join("; ") } : {}),
      staxids: h.staxids || ids,
    };
  });
  return { hits: enriched, filledCount };
}
