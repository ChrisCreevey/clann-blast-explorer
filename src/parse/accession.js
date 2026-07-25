// accession.js — recognise public sequence-database accession patterns in
// sseqid, so we can offer an "open in NCBI/UniProt" link where it will
// actually resolve, and show plain text (not a dead link) otherwise.
//
// Locally-assembled or locally-annotated genomes commonly produce identifiers
// like Prokka-style locus tags (e.g. "286604.5-LCADKAAL_01459") that are not
// public accessions at all — those must never get an external link.

const PATTERNS = [
  // RefSeq: NC_/NM_/NP_/XP_/XM_/WP_/YP_ etc. + digits, optional version
  { db: "ncbi", kind: "refseq", re: /^[A-Z]{2}_\d{5,}(\.\d+)?$/ },
  // GenBank protein: 3 letters + 5+ digits, optional version (e.g. AAB12345.1)
  { db: "ncbi", kind: "genbank-protein", re: /^[A-Z]{3}\d{5,}(\.\d+)?$/ },
  // UniProtKB accession (standard UniProt regex) — checked before the looser
  // GenBank nucleotide pattern below, since e.g. "P69905" matches both shapes.
  {
    db: "uniprot", kind: "uniprot",
    re: /^[OPQ][0-9][A-Z0-9]{3}[0-9](\.\d+)?$|^[A-NR-Z][0-9]([A-Z][A-Z0-9]{2}[0-9]){1,2}(\.\d+)?$/,
  },
  // GenBank nucleotide: 1-2 letters + 5-6 digits, optional version (e.g. AF123456.1, U12345)
  { db: "ncbi", kind: "genbank-nucleotide", re: /^[A-Z]{1,2}\d{5,6}(\.\d+)?$/ },
  // Bare numeric GI number (legacy NCBI identifier)
  { db: "ncbi", kind: "gi", re: /^\d{6,}$/ },
];

/**
 * Classify a subject/query sequence ID as a recognised public accession, or null
 * if it doesn't match any known pattern (e.g. a local assembly/locus-tag ID).
 * Returns { db, kind } or null.
 */
export function classifyAccession(id) {
  if (!id) return null;
  const bare = String(id).split(/\s+/)[0];
  for (const { db, kind, re } of PATTERNS) {
    if (re.test(bare)) return { db, kind, id: bare };
  }
  return null;
}

const REFSEQ_PROTEIN_PREFIX = /^(AP|NP|WP|XP|YP)_/;

/** Build the external link URL for a recognised accession, or null. */
export function accessionLinkUrl(id) {
  const hit = classifyAccession(id);
  if (!hit) return null;
  if (hit.kind === "gi") {
    return `https://www.ncbi.nlm.nih.gov/sviewer/viewer.fcgi?id=${encodeURIComponent(hit.id)}`;
  }
  if (hit.kind === "genbank-protein" || (hit.kind === "refseq" && REFSEQ_PROTEIN_PREFIX.test(hit.id))) {
    return `https://www.ncbi.nlm.nih.gov/protein/${encodeURIComponent(hit.id)}`;
  }
  if (hit.db === "ncbi") {
    return `https://www.ncbi.nlm.nih.gov/nuccore/${encodeURIComponent(hit.id)}`;
  }
  if (hit.db === "uniprot") {
    return `https://www.uniprot.org/uniprotkb/${encodeURIComponent(hit.id)}`;
  }
  return null;
}
