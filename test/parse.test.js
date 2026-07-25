import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { parse, ColumnMappingNeeded } from "../src/parse/index.js";
import { parseFasta, matchFastaIds, toFastaText } from "../src/parse/fasta.js";

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
