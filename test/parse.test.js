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
import { computeRBH } from "../src/analysis/rbh.js";
import { toDelimited } from "../export/table-export.js";
import {
  querySeqEntriesFromHits, subjectSeqEntriesFromHits, matchedFastaEntries, toFasta, accessionListText,
} from "../export/fasta-export.js";

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
  const forward = parse("q1\ts1\t99\t100\t0\t0\t1\t100\t1\t100\t1e-50\t200\nq2\ts2\t1\t1\t1\t1\t1\t1\t1\t1\t1\t1\n", { filename: "f.tsv" });
  const reverse = parse("s1\tq1\t99\t100\t0\t0\t1\t100\t1\t100\t1e-50\t200\n", { filename: "r.tsv" });
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
