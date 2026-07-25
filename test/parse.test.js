import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { parse, ColumnMappingNeeded } from "../src/parse/index.js";
import { parseFasta, matchFastaIds, toFastaText } from "../src/parse/fasta.js";
import { classifyAccession, accessionLinkUrl } from "../src/parse/accession.js";
import { defaultThresholds, passesThresholds, filterHits, computeQcov, classifyQuery } from "../src/analysis/filters.js";
import { perQuerySummary } from "../src/analysis/summary.js";
import { taxonLabel } from "../src/render/taxonomy.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(path.join(__dirname, "fixtures", name), "utf8");

test("standard -outfmt 6 (headerless, 12 columns)", () => {
  const data = parse(fixture("outfmt6.tsv"), { filename: "outfmt6.tsv" });
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

test("DIAMOND default tabular output (same 12-column layout)", () => {
  const data = parse(fixture("diamond.tsv"), { filename: "diamond.tsv" });
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
  const data = parse(fixture("outfmt6.tsv"), { filename: "outfmt6.tsv" });
  const rows = perQuerySummary(data, defaultThresholds());
  assert.equal(rows.find((r) => r.qseqid === "query1").flag, "hit");
  const strict = perQuerySummary(data, { ...defaultThresholds(), minPident: 99 });
  const q1Strict = strict.find((r) => r.qseqid === "query1");
  assert.equal(q1Strict.flag, "weak"); // has hits, but none reach 99% identity
});

test("taxonLabel: prefers sscinames, falls back to stitle bracket parsing", () => {
  assert.deepEqual(taxonLabel({ sscinames: "Mus musculus" }), { label: "Mus musculus", approximate: false });
  assert.deepEqual(taxonLabel({ stitle: "hypothetical protein [Escherichia coli]" }), { label: "Escherichia coli", approximate: true });
  assert.equal(taxonLabel({}), null);
});
