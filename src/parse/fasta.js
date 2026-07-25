// fasta.js — minimal FASTA parser + ID-matching subsetter.

/** Parse FASTA text into [{ id, header, seq }]. `id` is the header token before whitespace. */
export function parseFasta(text) {
  const records = [];
  let cur = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line) continue;
    if (line.startsWith(">")) {
      if (cur) records.push(cur);
      const header = line.slice(1);
      const id = header.split(/\s+/)[0];
      cur = { id, header, seq: "" };
    } else if (cur) {
      cur.seq += line.trim();
    }
  }
  if (cur) records.push(cur);
  return records;
}

/** Strip a trailing version suffix like ".1" from an accession, for fallback matching. */
function stripVersion(id) {
  return id.replace(/\.\d+$/, "");
}

/**
 * Match FASTA records against a list of target IDs (e.g. qseqid/sseqid values).
 * Tries exact match first, then version-stripped match.
 * Returns { matched: Map<targetId, record>, unmatched: string[] }.
 */
export function matchFastaIds(records, targetIds) {
  const byExact = new Map();
  const byStripped = new Map();
  for (const rec of records) {
    if (!byExact.has(rec.id)) byExact.set(rec.id, rec);
    const stripped = stripVersion(rec.id);
    if (!byStripped.has(stripped)) byStripped.set(stripped, rec);
  }
  const matched = new Map();
  const unmatched = [];
  for (const id of targetIds) {
    const rec = byExact.get(id) || byStripped.get(stripVersion(id));
    if (rec) matched.set(id, rec);
    else unmatched.push(id);
  }
  return { matched, unmatched };
}

export function toFastaText(entries) {
  // entries: [{ id, seq }] — wraps at 70 chars, matching common FASTA convention.
  return entries
    .map(({ id, seq }) => {
      const wrapped = seq.match(/.{1,70}/g) || [""];
      return `>${id}\n${wrapped.join("\n")}`;
    })
    .join("\n") + "\n";
}
