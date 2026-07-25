// blast-tabular.js — parser for BLAST -outfmt 6/7 and DIAMOND default tabular output.

export const STANDARD_12 = [
  "qseqid", "sseqid", "pident", "length", "mismatch", "gapopen",
  "qstart", "qend", "sstart", "send", "evalue", "bitscore",
];

const NUMERIC_FIELDS = new Set([
  "pident", "length", "mismatch", "gapopen", "qstart", "qend", "sstart", "send",
  "evalue", "bitscore", "qlen", "slen", "qcovs", "qcovhsp",
]);

function coerce(field, raw) {
  if (raw === undefined || raw === "") return undefined;
  if (NUMERIC_FIELDS.has(field)) {
    const n = Number(raw);
    return Number.isNaN(n) ? raw : n;
  }
  if (field === "staxids") return raw.split(";").map((s) => s.trim()).filter(Boolean);
  return raw;
}

function rowToHit(cols, values) {
  const hit = {};
  cols.forEach((field, i) => {
    if (!field || field === "-") return;
    const v = coerce(field, values[i]);
    if (v !== undefined) hit[field] = v;
  });
  return hit;
}

/**
 * Parse -outfmt 7 "# Fields:" comment line into column names.
 * NCBI writes human labels like "query acc.ver" — map the common ones to our field names.
 */
const FIELD_LABEL_MAP = {
  "query id": "qseqid", "query acc.": "qseqid", "query acc.ver": "qseqid", "query gi": "qseqid",
  "subject id": "sseqid", "subject acc.": "sseqid", "subject acc.ver": "sseqid", "subject gi": "sseqid",
  "% identity": "pident", "alignment length": "length", "mismatches": "mismatch",
  "gap opens": "gapopen", "q. start": "qstart", "q. end": "qend", "s. start": "sstart", "s. end": "send",
  "evalue": "evalue", "bit score": "bitscore",
  "query length": "qlen", "subject length": "slen",
  "subject tax ids": "staxids", "subject sci names": "sscinames",
  "subject com names": "scomnames", "subject blast names": "sskingdoms", "subject super kingdoms": "sskingdoms",
  "% query coverage per subject": "qcovs", "% query coverage per hsp": "qcovhsp",
  "subject title": "stitle", "subject strand": "sstrand",
  "query seq": "qseq", "subject seq": "sseq",
};

export function parseFieldsLine(line) {
  const raw = line.replace(/^#\s*Fields:\s*/, "");
  return raw.split(",").map((s) => {
    const label = s.trim();
    return FIELD_LABEL_MAP[label] || label;
  });
}

/**
 * Detect and parse BLAST outfmt 6/7 or DIAMOND tabular text.
 * Returns { format, columns, hits, warnings } or throws with a descriptive message.
 */
export function parseBlastTabular(text, opts = {}) {
  const lines = text.split(/\r?\n/);
  let columns = opts.columns ? [...opts.columns] : null;
  let format = "blast-outfmt6";
  const dataLines = [];
  let sawFieldsComment = false;

  for (const line of lines) {
    if (!line.trim()) continue;
    if (line.startsWith("#")) {
      if (line.startsWith("# Fields:")) {
        columns = parseFieldsLine(line);
        sawFieldsComment = true;
        format = "blast-outfmt7";
      }
      continue;
    }
    dataLines.push(line);
  }

  if (dataLines.length === 0) {
    throw new Error("No data rows found (only comments/blank lines).");
  }

  const firstCols = dataLines[0].split("\t");
  if (!columns) {
    if (firstCols.length === STANDARD_12.length) {
      columns = STANDARD_12;
    } else if (firstCols.length > STANDARD_12.length) {
      columns = STANDARD_12.concat(
        new Array(firstCols.length - STANDARD_12.length).fill(null).map((_, i) => `extra${i + 1}`)
      );
    } else {
      throw new Error(
        `Column count (${firstCols.length}) is fewer than the standard 12-column format and no "# Fields:" line was found. Manual column mapping is needed.`
      );
    }
  } else if (columns.length !== firstCols.length) {
    throw new Error(
      `Declared column count (${columns.length}) does not match data (${firstCols.length} columns per row). Manual column mapping is needed.`
    );
  }

  const hits = dataLines.map((line) => rowToHit(columns, line.split("\t")));

  const ambiguous = !sawFieldsComment && !validateSample(hits);
  if (ambiguous) {
    throw new Error(
      "Column values don't look like standard BLAST output (pident should be 0-100, evalue should be numeric). Manual column mapping is needed."
    );
  }

  return { format, columns, hits };
}

function validateSample(hits) {
  const sample = hits.slice(0, Math.min(20, hits.length));
  for (const h of sample) {
    if (typeof h.pident === "number" && (h.pident < 0 || h.pident > 100)) return false;
    if (h.evalue !== undefined && typeof h.evalue !== "number") return false;
  }
  return true;
}
