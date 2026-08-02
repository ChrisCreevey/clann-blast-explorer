import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { parse, ColumnMappingNeeded } from "../src/parse/index.js";
import { parseFasta, matchFastaIds, toFastaText } from "../src/parse/fasta.js";
import { classifyAccession, accessionLinkUrl } from "../src/parse/accession.js";
import { guessColumns, STANDARD_12 } from "../src/parse/blast-tabular.js";
import { defaultThresholds, passesThresholds, filterHits, computeQcov, classifyQuery } from "../src/analysis/filters.js";
import { perQuerySummary, bestHits } from "../src/analysis/summary.js";
import { taxonLabel } from "../src/render/taxonomy.js";
import { computeRBH } from "../src/analysis/rbh.js";
import {
  parseTarEntries, parseNamesDmp, extractTaxidFromId, buildTaxonPreview, enrichHitsWithTaxonomy,
} from "../src/parse/taxdump.js";
import { decompressIfNeeded, listZipEntries } from "../src/parse/compressed.js";
import { decodeTaxonomyDb, resolveLineage, resolveLineageBatch, enrichHitsWithLineage } from "../src/analysis/taxonomy-db.js";
import { toDelimited } from "../export/table-export.js";
import {
  querySeqEntriesFromHits, subjectSeqEntriesFromHits, matchedFastaEntries, toFasta, accessionListText,
} from "../export/fasta-export.js";
import { toEdnaSampleRows, toEdnaSampleTsv, UNCLASSIFIED } from "../export/edna-export.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(path.join(__dirname, "fixtures", name), "utf8");
const fixtureBuffer = (name) => readFileSync(path.join(__dirname, "fixtures", name));

test("standard -outfmt 6 (headerless, 12 columns): always needs manual mapping, even at the standard count", () => {
  // No "# Fields:" line and no header row — a custom -outfmt order could still
  // have exactly 12 columns, so this must never be guessed silently.
  assert.throws(() => parse(fixture("outfmt6.tsv"), { filename: "outfmt6.tsv" }), ColumnMappingNeeded);

  const data = parse(fixture("outfmt6.tsv"), { filename: "outfmt6.tsv", columns: STANDARD_12 });
  assert.equal(data.meta.format, "blast-outfmt6");
  assert.equal(data.hits.length, 3);
  assert.equal(data.queries.length, 2);
  const q1 = data.queries.find((q) => q.qseqid === "query1");
  assert.equal(q1.hitCount, 2);
  assert.equal(q1.best.sseqid, "sbjct_A"); // higher bitscore
  assert.equal(typeof data.hits[0].pident, "number");
  assert.equal(typeof data.hits[0].evalue, "number");
});

test("-outfmt 7 with '# Fields:' line and taxonomy columns", () => {
  const data = parse(fixture("outfmt7.tsv"), { filename: "outfmt7.tsv" });
  assert.equal(data.meta.format, "blast-outfmt7");
  assert.equal(data.meta.hasTaxonomy, true);
  assert.equal(data.hits.length, 3);
  assert.deepEqual(data.hits[0].staxids, ["9606"]);
  assert.equal(data.hits[0].sscinames, "Homo sapiens");
});

test("DIAMOND default tabular output (same 12-column layout, also needs manual mapping)", () => {
  assert.throws(() => parse(fixture("diamond.tsv"), { filename: "diamond.tsv" }), ColumnMappingNeeded);

  const data = parse(fixture("diamond.tsv"), { filename: "diamond.tsv", columns: STANDARD_12 });
  assert.equal(data.hits.length, 2);
  assert.equal(data.hits[0].qseqid, "q1");
  assert.equal(data.hits[0].pident, 99.0);
});

test("files with qseq/sseq columns set hasSequences", () => {
  const data = parse(fixture("with-seqs.tsv"), { filename: "with-seqs.tsv" });
  assert.equal(data.meta.hasSequences, true);
  assert.equal(data.hits[0].qseq, "ACGTACGTAC");
  assert.equal(data.hits[0].sseq, "ACGTACGTTC");
});

test("malformed/ambiguous column count triggers mapping, not a crash", () => {
  assert.throws(() => parse(fixture("ambiguous.tsv"), { filename: "ambiguous.tsv" }), ColumnMappingNeeded);
});

test("ColumnMappingNeeded carries preview rows for the manual mapping UI", () => {
  try {
    parse(fixture("ambiguous.tsv"), { filename: "ambiguous.tsv" });
    assert.fail("expected ColumnMappingNeeded");
  } catch (err) {
    assert.ok(err instanceof ColumnMappingNeeded);
    assert.ok(err.previewRows.length > 0);
    assert.deepEqual(err.previewRows[0], ["query1", "sbjct_A", "200", "3"]);
  }
});

test("guessColumns: best-effort positional guess, blank past the standard 12", () => {
  assert.deepEqual(guessColumns(12), STANDARD_12);
  assert.deepEqual(guessColumns(3), ["qseqid", "sseqid", "pident"]);
  assert.deepEqual(guessColumns(14).slice(12), ["", ""]);
});

test("manual column mapping recovers a file auto-detection can't handle", () => {
  // 4 columns, no header, no "# Fields:" — same shape as ambiguous.tsv, but this
  // time the caller supplies a manual mapping instead of giving up.
  const data = parse(fixture("ambiguous.tsv"), {
    filename: "ambiguous.tsv",
    columns: ["qseqid", "sseqid", "length", "mismatch"],
  });
  assert.equal(data.hits.length, 2);
  assert.equal(data.hits[0].qseqid, "query1");
  assert.equal(data.hits[0].sseqid, "sbjct_A");
  assert.equal(data.hits[0].length, 200);
  assert.equal(data.hits[0].mismatch, 3);
});

test("plain uncommented header row is detected and used for column mapping", () => {
  const data = parse(fixture("plain-header.tsv"), { filename: "plain-header.tsv" });
  assert.equal(data.hits.length, 2);
  assert.equal(data.hits[0].qseqid, "query1");
  assert.equal(data.hits[0].sseqid, "sbjct_A");
  assert.equal(typeof data.hits[0].pident, "number");
  assert.equal(data.queries.length, 2);
});

test("accession pattern recognition: public accessions link out, local IDs don't", () => {
  assert.equal(classifyAccession("NP_001234567.1").db, "ncbi");
  assert.equal(classifyAccession("AAB12345.1").db, "ncbi");
  assert.equal(classifyAccession("AF123456.1").db, "ncbi");
  assert.equal(classifyAccession("P69905").db, "uniprot");
  assert.equal(classifyAccession("286604.5-LCADKAAL_01459"), null); // Prokka-style local locus tag
  assert.equal(classifyAccession("contig_42_scaffold"), null);

  assert.ok(accessionLinkUrl("P69905").includes("uniprot.org"));
  assert.ok(accessionLinkUrl("NP_001234567.1").includes("ncbi.nlm.nih.gov/protein"));
  assert.equal(accessionLinkUrl("286604.5-LCADKAAL_01459"), null);
});

test("FASTA parsing and ID matching: exact, version-suffix, duplicates", () => {
  const fasta = parseFasta(">ABC123.1 some protein\nACGTACGT\n>DEF456\nTTTTGGGG\n>DEF456\nCCCCAAAA\n");
  assert.equal(fasta.length, 3);
  assert.equal(fasta[0].id, "ABC123.1");
  assert.equal(fasta[0].seq, "ACGTACGT");

  const { matched, unmatched } = matchFastaIds(fasta, ["ABC123", "DEF456", "GHI789"]);
  assert.equal(matched.get("ABC123").seq, "ACGTACGT"); // version-suffix mismatch resolved
  assert.equal(matched.get("DEF456").seq, "TTTTGGGG"); // duplicate ID: first wins
  assert.deepEqual(unmatched, ["GHI789"]);
});

test("toFastaText wraps sequences", () => {
  const text = toFastaText([{ id: "x", seq: "A".repeat(75) }]);
  const lines = text.trim().split("\n");
  assert.equal(lines[0], ">x");
  assert.equal(lines[1].length, 70);
  assert.equal(lines[2].length, 5);
});

test("computeQcov: uses qcovs when present, else derives from qlen and aligned span", () => {
  assert.equal(computeQcov({ qcovs: 87 }), 87);
  assert.equal(computeQcov({ qlen: 200, qstart: 1, qend: 100 }), 50);
  assert.equal(computeQcov({}), undefined);
});

test("passesThresholds: numeric and self-hit/taxon filters", () => {
  const hit = { qseqid: "q1", sseqid: "s1", pident: 95, evalue: 1e-10, bitscore: 200, length: 150, sscinames: "Homo sapiens" };
  assert.equal(passesThresholds(hit, defaultThresholds()), true);
  assert.equal(passesThresholds(hit, { ...defaultThresholds(), minPident: 99 }), false);
  assert.equal(passesThresholds(hit, { ...defaultThresholds(), maxEvalue: 1e-20 }), false);
  assert.equal(passesThresholds({ ...hit, sseqid: "q1" }, { ...defaultThresholds(), excludeSelfHits: true }), false);
  assert.equal(passesThresholds(hit, { ...defaultThresholds(), taxonInclude: "mus musculus" }), false);
  assert.equal(passesThresholds(hit, { ...defaultThresholds(), taxonInclude: "homo" }), true);
  assert.equal(passesThresholds(hit, { ...defaultThresholds(), taxonExclude: "homo" }), false);
});

test("passesThresholds: rank-specific taxon matching uses taxonLineage, not sscinames/staxids text", () => {
  const withLineage = {
    qseqid: "q1", sseqid: "s1", sscinames: "Homo sapiens",
    taxonLineage: { superkingdom: "Eukaryota", kingdom: "Metazoa", phylum: "Chordata", genus: "Homo", species: "Homo sapiens" },
  };
  const noLineage = { qseqid: "q1", sseqid: "s2", sscinames: "Homo sapiens" };

  // "any" (default) still matches the flat name/staxid text as before.
  assert.equal(passesThresholds(withLineage, { ...defaultThresholds(), taxonInclude: "homo sapiens" }), true);

  // A specific rank matches only that rank's resolved value...
  assert.equal(passesThresholds(withLineage, { ...defaultThresholds(), taxonInclude: "chordata", taxonRank: "phylum" }), true);
  assert.equal(passesThresholds(withLineage, { ...defaultThresholds(), taxonInclude: "arthropoda", taxonRank: "phylum" }), false);
  // ...and doesn't match against an unrelated rank's value even though the text exists elsewhere on the hit.
  assert.equal(passesThresholds(withLineage, { ...defaultThresholds(), taxonInclude: "homo sapiens", taxonRank: "phylum" }), false);
  // A hit with no taxonLineage never matches a rank-specific filter, regardless of its flat name.
  assert.equal(passesThresholds(noLineage, { ...defaultThresholds(), taxonInclude: "chordata", taxonRank: "phylum" }), false);

  // Exclude works the same way, scoped to the rank.
  assert.equal(passesThresholds(withLineage, { ...defaultThresholds(), taxonExclude: "chordata", taxonRank: "phylum" }), false);
  assert.equal(passesThresholds(withLineage, { ...defaultThresholds(), taxonExclude: "arthropoda", taxonRank: "phylum" }), true);
});

test("filterHits: applies top-N-per-query cap by bitscore", () => {
  const hits = [
    { qseqid: "q1", sseqid: "a", bitscore: 100 },
    { qseqid: "q1", sseqid: "b", bitscore: 300 },
    { qseqid: "q1", sseqid: "c", bitscore: 200 },
    { qseqid: "q2", sseqid: "d", bitscore: 50 },
  ];
  const capped = filterHits(hits, { ...defaultThresholds(), topNPerQuery: 1 });
  assert.equal(capped.length, 2);
  assert.equal(capped.find((h) => h.qseqid === "q1").sseqid, "b"); // highest bitscore kept
});

test("classifyQuery: hit / weak / none", () => {
  assert.equal(classifyQuery([{}], [{}]), "hit");
  assert.equal(classifyQuery([{}], []), "weak");
  assert.equal(classifyQuery([], []), "none");
});

test("perQuerySummary: flags queries against active thresholds", () => {
  const data = parse(fixture("outfmt6.tsv"), { filename: "outfmt6.tsv", columns: STANDARD_12 });
  const rows = perQuerySummary(data, defaultThresholds());
  assert.equal(rows.find((r) => r.qseqid === "query1").flag, "hit");
  const strict = perQuerySummary(data, { ...defaultThresholds(), minPident: 99 });
  const q1Strict = strict.find((r) => r.qseqid === "query1");
  assert.equal(q1Strict.flag, "weak"); // has hits, but none reach 99% identity
});

test("bestHits: returns every hit tied for the top bit score, not just the first", () => {
  const hits = [
    { qseqid: "q1", sseqid: "a", bitscore: 300 },
    { qseqid: "q1", sseqid: "b", bitscore: 300 },
    { qseqid: "q1", sseqid: "c", bitscore: 250 },
  ];
  const tied = bestHits(hits);
  assert.equal(tied.length, 2);
  assert.deepEqual(tied.map((h) => h.sseqid), ["a", "b"]);
  assert.deepEqual(bestHits([]), []);
  assert.equal(bestHits([{ qseqid: "q2", sseqid: "x", bitscore: 100 }]).length, 1);
});

test("perQuerySummary: bestTied lists every tied top-bitscore hit for that query", () => {
  const text = "q1\ta\t99\t100\t0\t0\t1\t100\t1\t100\t1e-50\t300\nq1\tb\t95\t100\t0\t0\t1\t100\t1\t100\t1e-45\t300\n";
  const data = parse(text, { filename: "tied.tsv", columns: STANDARD_12 });
  const rows = perQuerySummary(data, defaultThresholds());
  const q1 = rows.find((r) => r.qseqid === "q1");
  assert.equal(q1.bestTied.length, 2);
  assert.deepEqual(q1.bestTied.map((h) => h.sseqid), ["a", "b"]);
  assert.equal(q1.best.sseqid, "a"); // .best is just bestTied[0], for callers that want a single hit
});

test("taxonLabel: prefers sscinames, falls back to stitle bracket parsing", () => {
  assert.deepEqual(taxonLabel({ sscinames: "Mus musculus" }), { label: "Mus musculus", approximate: false });
  assert.deepEqual(taxonLabel({ stitle: "hypothetical protein [Escherichia coli]" }), { label: "Escherichia coli", approximate: true });
  assert.equal(taxonLabel({}), null);
});

test("computeRBH: reciprocal / one-way / no-hit classification", () => {
  const forward = parse(fixture("rbh-forward.tsv"), { filename: "rbh-forward.tsv" });
  const reverse = parse(fixture("rbh-reverse.tsv"), { filename: "rbh-reverse.tsv" });
  const { classification, pairs, counts } = computeRBH(forward, reverse, defaultThresholds());

  assert.equal(counts.reciprocal, 2); // geneA<->B_geneA, geneB<->B_geneB
  assert.equal(counts.oneWay, 1); // geneC's best hit B_geneY reciprocates to geneD, not geneC
  assert.equal(counts.noHit, 0);

  const geneA = classification.find((c) => c.qseqid === "geneA");
  assert.equal(geneA.status, "reciprocal");
  assert.equal(geneA.partner, "B_geneA");

  const geneC = classification.find((c) => c.qseqid === "geneC");
  assert.equal(geneC.status, "one-way");

  assert.equal(pairs.length, 2);
  assert.ok(pairs.every((p) => p.fwdBest && p.revBest));
});

test("computeRBH: a query with no hit in either direction is classified 'no-hit'", () => {
  const forward = parse("q1\ts1\t99\t100\t0\t0\t1\t100\t1\t100\t1e-50\t200\nq2\ts2\t1\t1\t1\t1\t1\t1\t1\t1\t1\t1\n", { filename: "f.tsv", columns: STANDARD_12 });
  const reverse = parse("s1\tq1\t99\t100\t0\t0\t1\t100\t1\t100\t1e-50\t200\n", { filename: "r.tsv", columns: STANDARD_12 });
  const { classification } = computeRBH(forward, reverse, { ...defaultThresholds(), minBitscore: 50 });
  // q2's only hit has bitscore 1, below the threshold — no hit passes, so it's 'no-hit', not 'one-way'.
  assert.equal(classification.find((c) => c.qseqid === "q2").status, "no-hit");
});

test("toDelimited: builds TSV with header and escapes embedded delimiters", () => {
  const text = toDelimited([{ a: "x\ty", b: 2 }], ["a", "b"]);
  const lines = text.trim().split("\n");
  assert.equal(lines[0], "a\tb");
  assert.equal(lines[1], '"x\ty"\t2');
});

test("querySeqEntriesFromHits: one entry per query, first qseq wins", () => {
  const hits = [
    { qseqid: "q1", qseq: "ACGT" },
    { qseqid: "q1", qseq: "TTTT" }, // ignored: q1 already captured
    { qseqid: "q2", qseq: "GGCC" },
    { qseqid: "q3" }, // no qseq column — excluded
  ];
  const entries = querySeqEntriesFromHits(hits);
  assert.deepEqual(entries, [{ id: "q1", seq: "ACGT" }, { id: "q2", seq: "GGCC" }]);
});

test("subjectSeqEntriesFromHits: one entry per hit row with an sseq", () => {
  const hits = [
    { qseqid: "q1", sseqid: "s1", sseq: "AAAA" },
    { qseqid: "q2", sseqid: "s1", sseq: "CCCC" }, // same subject, different query — both kept
    { qseqid: "q3", sseqid: "s2" }, // no sseq — excluded
  ];
  const entries = subjectSeqEntriesFromHits(hits);
  assert.deepEqual(entries, [{ id: "s1", seq: "AAAA" }, { id: "s1", seq: "CCCC" }]);
});

test("matchedFastaEntries: ID-matches against uploaded FASTA, tracks unmatched", () => {
  const records = parseFasta(">q1.1 desc\nACGT\n>q2\nGGCC\n");
  const { entries, unmatched } = matchedFastaEntries(records, ["q1", "q2", "q4"]);
  assert.deepEqual(entries, [{ id: "q1.1", seq: "ACGT" }, { id: "q2", seq: "GGCC" }]);
  assert.deepEqual(unmatched, ["q4"]);
});

test("toFasta / accessionListText: output formats", () => {
  assert.equal(toFasta([{ id: "x", seq: "ACGT" }]), ">x\nACGT\n");
  assert.equal(accessionListText(["a", "b"]), "a\nb\n");
});

test("parseNamesDmp: keeps scientific names and the best common name, skips synonyms", () => {
  const text = [
    "9606\t|\tHomo sapiens\t|\t\t|\tscientific name\t|",
    "9606\t|\tman\t|\t\t|\tcommon name\t|",
    "9606\t|\thuman\t|\t\t|\tgenbank common name\t|",
    "9606\t|\tHomo sapiens Linnaeus, 1758\t|\t\t|\tsynonym\t|",
    "562\t|\tEscherichia coli\t|\t\t|\tscientific name\t|",
  ].join("\n");
  const map = parseNamesDmp(text);
  assert.equal(map.get("9606").sciName, "Homo sapiens");
  assert.equal(map.get("9606").comName, "human"); // genbank common name preferred over plain common name
  assert.equal(map.get("562").sciName, "Escherichia coli");
  assert.equal(map.has("1"), false);
});

test("extractTaxidFromId: delimiter and regex patterns", () => {
  assert.equal(extractTaxidFromId("9606.ENSP00000269305", { type: "delimiter", delimiter: "." }), "9606");
  assert.equal(extractTaxidFromId("1307.5988-XYZ_00123", { type: "delimiter", delimiter: "-" }), null); // "1307.5988" isn't all-digit
  assert.equal(extractTaxidFromId("1307-5988-XYZ", { type: "delimiter", delimiter: "-" }), "1307");
  assert.equal(extractTaxidFromId("no-number-here", { type: "delimiter", delimiter: "-" }), null);
  assert.equal(extractTaxidFromId("9606.ENSP00000269305", { type: "regex", source: "^(\\d+)" }), "9606");
  assert.equal(extractTaxidFromId("ENSP00000269305", { type: "regex", source: "^(\\d+)" }), null);
});

test("buildTaxonPreview: resolves candidate taxon IDs per distinct sseqid, up to the limit", () => {
  const taxonMap = new Map([["9606", { sciName: "Homo sapiens" }], ["562", { sciName: "Escherichia coli" }]]);
  const hits = [
    { qseqid: "q1", sseqid: "9606.PROT1" },
    { qseqid: "q1", sseqid: "9606.PROT1" }, // duplicate sseqid — only counted once
    { qseqid: "q2", sseqid: "562.PROT2" },
    { qseqid: "q3", sseqid: "unknown.PROT3" },
  ];
  const rows = buildTaxonPreview(hits, taxonMap, { mode: "pattern", pattern: { type: "delimiter", delimiter: "." } }, 10);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0].names, ["Homo sapiens"]);
  assert.deepEqual(rows[2].names, []); // "unknown" isn't in the map
});

test("enrichHitsWithTaxonomy: backfills sscinames/scomnames from staxids, never overwrites existing names", () => {
  const taxonMap = new Map([["9606", { sciName: "Homo sapiens", comName: "human" }]]);
  const hits = [
    { qseqid: "q1", sseqid: "s1", staxids: ["9606"] },
    { qseqid: "q2", sseqid: "s2", staxids: ["1"] }, // not in the map — left alone
    { qseqid: "q3", sseqid: "s3", sscinames: "Already set" }, // has a name — untouched even with staxids
  ];
  const { hits: enriched, filledCount } = enrichHitsWithTaxonomy(hits, taxonMap, { mode: "staxids" });
  assert.equal(filledCount, 1);
  assert.equal(enriched[0].sscinames, "Homo sapiens");
  assert.equal(enriched[0].scomnames, "human");
  assert.equal(enriched[1].sscinames, undefined);
  assert.equal(enriched[2].sscinames, "Already set");
});

test("enrichHitsWithTaxonomy: pattern-extraction source works the same way as staxids", () => {
  const taxonMap = new Map([["9606", { sciName: "Homo sapiens" }]]);
  const hits = [{ qseqid: "q1", sseqid: "9606.PROT1" }];
  const source = { mode: "pattern", pattern: { type: "delimiter", delimiter: "." } };
  const { hits: enriched, filledCount } = enrichHitsWithTaxonomy(hits, taxonMap, source);
  assert.equal(filledCount, 1);
  assert.equal(enriched[0].sscinames, "Homo sapiens");
  assert.deepEqual(enriched[0].staxids, ["9606"]);
});

test("enrichHitsWithLineage: fills sscinames/sskingdoms and attaches taxonLineage for rank filtering", () => {
  const LINEAGE = { taxid: 9606, superkingdom: "Eukaryota", kingdom: "Metazoa", phylum: "Chordata", genus: "Homo", species: "Homo sapiens" };
  const fakeDb = { resolveLineage: (taxid) => (String(taxid) === "9606" ? LINEAGE : null) };

  const hits = [
    { qseqid: "q1", sseqid: "s1", staxids: ["9606"] },
    { qseqid: "q2", sseqid: "s2", staxids: ["1"] }, // unresolvable — left alone
    { qseqid: "q3", sseqid: "s3", staxids: ["9606"], sscinames: "Already set" }, // name kept, but lineage still attached
    { qseqid: "q4", sseqid: "s4" }, // no staxids at all
  ];
  const { hits: enriched, filledCount } = enrichHitsWithLineage(hits, fakeDb);

  assert.equal(filledCount, 1); // only q1's name was actually filled in
  assert.equal(enriched[0].sscinames, "Homo sapiens");
  assert.equal(enriched[0].sskingdoms, "Eukaryota");
  assert.deepEqual(enriched[0].taxonLineage, LINEAGE);

  assert.equal(enriched[1].taxonLineage, undefined);

  assert.equal(enriched[2].sscinames, "Already set"); // never overwritten
  assert.deepEqual(enriched[2].taxonLineage, LINEAGE); // but lineage attached regardless, for rank filtering

  assert.equal(enriched[3].taxonLineage, undefined);
});

test("resolveLineage: walks parent pointers to the canonical ranks, tolerates alias ranks and unknown taxids", () => {
  // Minimal hand-built binary matching tools/build-taxonomy-db.js's format:
  // root(1) -> domain:Eukaryota(2) -> phylum:Chordata(3) -> species:Homo sapiens(4)
  // Uses "domain" (current NCBI taxdump) rather than "superkingdom" to exercise the rank alias.
  const ranks = ["no rank", "domain", "phylum", "species"];
  const nodes = [
    { taxid: 1, parent: 1, rank: "no rank", name: "root" },
    { taxid: 2, parent: 1, rank: "domain", name: "Eukaryota" },
    { taxid: 3, parent: 2, rank: "phylum", name: "Chordata" },
    { taxid: 4, parent: 3, rank: "species", name: "Homo sapiens" },
  ];
  const maxTaxid = 4;
  const parentTaxid = new Int32Array(maxTaxid + 1).fill(-1);
  const rankId = new Uint8Array(maxTaxid + 1).fill(255);
  const nameOffset = new Uint32Array(maxTaxid + 1).fill(0xffffffff);
  const nameLength = new Uint16Array(maxTaxid + 1);
  const nameChunks = [];
  let nameOff = 0;
  for (const n of nodes) {
    parentTaxid[n.taxid] = n.parent;
    rankId[n.taxid] = ranks.indexOf(n.rank);
    const enc = new TextEncoder().encode(n.name);
    nameOffset[n.taxid] = nameOff;
    nameLength[n.taxid] = enc.length;
    nameChunks.push(enc);
    nameOff += enc.length;
  }
  const nameBlob = new Uint8Array(nameOff);
  { let p = 0; for (const c of nameChunks) { nameBlob.set(c, p); p += c.length; } }
  const rankTableBlob = new TextEncoder().encode(ranks.join("\0") + "\0");

  const headerLen = 16;
  const arraysLen = parentTaxid.byteLength + nameOffset.byteLength + nameLength.byteLength + rankId.byteLength;
  const buf = new ArrayBuffer(headerLen + arraysLen + rankTableBlob.length + 4 + nameBlob.length);
  const dv = new DataView(buf);
  let p = 0;
  new Uint8Array(buf, 0, 4).set(new TextEncoder().encode("CBTX")); p += 4;
  dv.setUint32(p, 1, true); p += 4;
  dv.setUint32(p, maxTaxid, true); p += 4;
  dv.setUint32(p, rankTableBlob.length, true); p += 4;
  new Int32Array(buf, p, maxTaxid + 1).set(parentTaxid); p += parentTaxid.byteLength;
  new Uint32Array(buf, p, maxTaxid + 1).set(nameOffset); p += nameOffset.byteLength;
  new Uint16Array(buf, p, maxTaxid + 1).set(nameLength); p += nameLength.byteLength;
  new Uint8Array(buf, p, maxTaxid + 1).set(rankId); p += rankId.byteLength;
  new Uint8Array(buf, p, rankTableBlob.length).set(rankTableBlob); p += rankTableBlob.length;
  dv.setUint32(p, nameBlob.length, true); p += 4;
  new Uint8Array(buf, p, nameBlob.length).set(nameBlob); p += nameBlob.length;

  const db = decodeTaxonomyDb(buf);
  const lineage = resolveLineage(db, 4);
  assert.equal(lineage.species, "Homo sapiens");
  assert.equal(lineage.phylum, "Chordata");
  assert.equal(lineage.superkingdom, "Eukaryota"); // "domain" aliased to "superkingdom"
  assert.equal(lineage.kingdom, undefined); // not present in this lineage — never invented

  assert.equal(resolveLineage(db, 999), null); // unknown taxid
  assert.deepEqual(resolveLineage(db, 1), { taxid: 1 }); // root: no canonical ranks above it

  const batch = resolveLineageBatch(db, [4, 999]);
  assert.equal(batch.get(4).species, "Homo sapiens");
  assert.equal(batch.get(999), null);
});

test("toEdnaSampleRows: one row per taxon from each query's best passing hit, unmatched queries pooled as Unclassified", () => {
  const data = {
    hits: [
      { qseqid: "q1", sseqid: "s1", bitscore: 500, taxonLineage: { species: "Homo sapiens" } },
      { qseqid: "q1", sseqid: "s1b", bitscore: 300, taxonLineage: { species: "Should not win — lower bitscore" } },
      { qseqid: "q2", sseqid: "s2", bitscore: 400, sscinames: "Mus musculus" }, // no taxonLineage — falls back to sscinames
      { qseqid: "q3", sseqid: "s3", bitscore: 50 }, // fails minBitscore below
    ],
    queries: [{ qseqid: "q1" }, { qseqid: "q2" }, { qseqid: "q3" }, { qseqid: "q4" }], // q4 has no hits at all
  };
  const thresholds = { ...defaultThresholds(), minBitscore: 100 };

  const rows = toEdnaSampleRows(data, thresholds);
  const byName = Object.fromEntries(rows.map((r) => [r.name, r.abundance]));
  assert.equal(byName["Homo sapiens"], 1);
  assert.equal(byName["Mus musculus"], 1);
  assert.equal(byName[UNCLASSIFIED], 2); // q3 (filtered out) + q4 (no hits)
  assert.equal(rows[0].name, UNCLASSIFIED); // highest abundance sorts first
  assert.equal(rows.reduce((s, r) => s + r.abundance, 0), 4); // every query counted exactly once

  const tsv = toEdnaSampleTsv(data, thresholds);
  assert.equal(tsv.split("\n")[0], "name\tabundance");
  assert.ok(tsv.includes("Homo sapiens\t1"));
});

test("parseTarEntries: walks fixed 512-byte tar headers to find files by name", () => {
  // Build a minimal single-file tar: one 512-byte header + one 512-byte content block.
  const header = new Uint8Array(512);
  const name = "names.dmp";
  for (let i = 0; i < name.length; i++) header[i] = name.charCodeAt(i);
  const sizeOctal = "14".padStart(11, "0") + "\0"; // 12 (decimal) bytes of content, as octal ASCII ("14" octal = 12 decimal)
  for (let i = 0; i < sizeOctal.length; i++) header[124 + i] = sizeOctal.charCodeAt(i);
  const content = new TextEncoder().encode("hello dmp!\n\n".padEnd(12, "\0")).slice(0, 12);
  const bytes = new Uint8Array(512 + 512);
  bytes.set(header, 0);
  bytes.set(content, 512);

  const entries = parseTarEntries(bytes);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, "names.dmp");
  assert.equal(entries[0].size, 12);
  const text = new TextDecoder().decode(bytes.subarray(entries[0].start, entries[0].start + entries[0].size));
  assert.equal(text, "hello dmp!\n\n");
});

test("decompressIfNeeded: gunzips a .gz upload and strips the extension from the filename", async () => {
  const buf = fixtureBuffer("compressed.tsv.gz");
  const file = new File([buf], "compressed.tsv.gz", { type: "application/gzip" });
  const result = await decompressIfNeeded(file);
  assert.ok(result);
  assert.equal(result.filename, "compressed.tsv");
  assert.equal(result.text, fixture("plain-header.tsv"));
});

test("decompressIfNeeded: extracts the first suitable entry from a .zip upload", async () => {
  const buf = fixtureBuffer("compressed.zip");
  const file = new File([buf], "compressed.zip", { type: "application/zip" });
  const result = await decompressIfNeeded(file);
  assert.ok(result);
  assert.equal(result.filename, "compressed-source.tsv");
  assert.equal(result.text, fixture("plain-header.tsv"));
});

test("decompressIfNeeded: returns null for a plain uncompressed file (detected by magic bytes, not extension)", async () => {
  const file = new File([fixture("plain-header.tsv")], "plain-header.tsv", { type: "text/plain" });
  assert.equal(await decompressIfNeeded(file), null);
});

test("listZipEntries: reads the central directory of the fixture zip", () => {
  const bytes = new Uint8Array(fixtureBuffer("compressed.zip"));
  const entries = listZipEntries(bytes);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, "compressed-source.tsv");
});
