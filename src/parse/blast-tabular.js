// blast-tabular.js — parser for BLAST -outfmt 6/7 and DIAMOND default tabular output.

export const STANDARD_12 = [
  "qseqid", "sseqid", "pident", "length", "mismatch", "gapopen",
  "qstart", "qend", "sstart", "send", "evalue", "bitscore",
];

/** Every field name the parser understands, for building a manual column-mapping UI. */
export const KNOWN_FIELDS = [
  "qseqid", "sseqid", "pident", "length", "mismatch", "gapopen", "qstart", "qend", "sstart", "send",
  "evalue", "bitscore", "qlen", "slen", "staxids", "sscinames", "scomnames", "sskingdoms", "sblastnames",
  "qcovs", "qcovhsp", "stitle", "qseq", "sseq",
];

/** Best-guess field name per column position, for prefilling a manual mapping UI. Empty string = skip. */
export function guessColumns(colCount) {
  return Array.from({ length: colCount }, (_, i) => STANDARD_12[i] || "");
}

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
  "subject com names": "scomnames", "subject blast names": "sblastnames", "subject super kingdoms": "sskingdoms",
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
 * Recognise a plain, uncommented header row (no leading '#'), e.g. one added
 * by a wrapper script: "qseqid\tsseqid\tpident\t...". Distinct from -outfmt 7's
 * "# Fields:" line, and distinct from headerless -outfmt 6 data.
 */
const HEADER_NAME_MAP = {
  qseqid: "qseqid", queryid: "qseqid", query: "qseqid", queryacc: "qseqid", queryaccver: "qseqid", querygi: "qseqid",
  sseqid: "sseqid", subjectid: "sseqid", subject: "sseqid", subjectacc: "sseqid", subjectaccver: "sseqid", subjectgi: "sseqid",
  pident: "pident", identity: "pident", pctidentity: "pident", percentidentity: "pident",
  length: "length", alignmentlength: "length", alnlen: "length", alnlength: "length",
  mismatch: "mismatch", mismatches: "mismatch",
  gapopen: "gapopen", gapopens: "gapopen",
  qstart: "qstart", querystart: "qstart",
  qend: "qend", queryend: "qend",
  sstart: "sstart", subjectstart: "sstart",
  send: "send", subjectend: "send",
  evalue: "evalue", expect: "evalue",
  bitscore: "bitscore", score: "bitscore",
  qlen: "qlen", querylength: "qlen",
  slen: "slen", subjectlength: "slen",
  staxids: "staxids", subjecttaxids: "staxids", taxid: "staxids", taxids: "staxids",
  sscinames: "sscinames", subjectscinames: "sscinames", scientificname: "sscinames",
  scomnames: "scomnames", subjectcomnames: "scomnames",
  sskingdoms: "sskingdoms", subjectkingdoms: "sskingdoms", subjectsuperkingdoms: "sskingdoms",
  sblastnames: "sblastnames", subjectblastnames: "sblastnames", blastname: "sblastnames", blastnames: "sblastnames",
  qcovs: "qcovs", qcovhsp: "qcovhsp",
  stitle: "stitle", subjecttitle: "stitle", title: "stitle",
  qseq: "qseq", queryseq: "qseq",
  sseq: "sseq", subjectseq: "sseq",
};

function normalizeHeaderToken(s) {
  return s.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Detect whether `cols` (the raw first data-line cells) is actually a plain
 * header row rather than data. Requires: no cell parses as a number, and most
 * cells match a known BLAST/DIAMOND column name (allowing unrecognised extras).
 */
export function detectPlainHeaderRow(cols) {
  if (cols.some((c) => c.trim() !== "" && !Number.isNaN(Number(c.trim())))) return null;
  const mapped = cols.map((c) => HEADER_NAME_MAP[normalizeHeaderToken(c)] || null);
  const matched = mapped.filter(Boolean).length;
  if (matched === 0 || matched / cols.length < 0.7) return null;
  return mapped.map((m, i) => m || `extra${i + 1}`);
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

  let firstCols = dataLines[0].split("\t");
  let sawPlainHeader = false;
  if (!columns) {
    const headerCols = detectPlainHeaderRow(firstCols);
    if (headerCols) {
      columns = headerCols;
      sawPlainHeader = true;
      dataLines.shift();
      if (dataLines.length === 0) throw new Error("No data rows found after the header row.");
      firstCols = dataLines[0].split("\t");
    }
  }
  if (!columns) {
    // No "# Fields:" line and no recognisable header row — never guess the
    // column order silently, even when the count happens to match the
    // standard 12: a custom `-outfmt "6 ..."` order can easily still have
    // exactly 12 columns in a different arrangement. Manual confirmation
    // (prefilled with this same positional guess) is always required here.
    throw new Error(
      firstCols.length < STANDARD_12.length
        ? `Column count (${firstCols.length}) is fewer than the standard 12-column format and no header was found. Manual column mapping is needed.`
        : `No column header found (no "# Fields:" line, no recognised header row). Manual column mapping is needed to confirm column order.`
    );
  } else if (columns.length !== firstCols.length) {
    throw new Error(
      `Declared column count (${columns.length}) does not match data (${firstCols.length} columns per row). Manual column mapping is needed.`
    );
  }

  const hits = dataLines.map((line) => rowToHit(columns, line.split("\t")));

  const ambiguous = !sawFieldsComment && !sawPlainHeader && !validateSample(hits);
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
