#!/usr/bin/env node
// build-taxonomy-db.js — downloads NCBI taxdump and builds a compact binary
// taxid -> (parent, rank, scientific name) lookup for client-side use.
//
// Usage:
//   node tools/build-taxonomy-db.js [--out-dir data] [--url <taxdump.tar.gz URL>]
//
// Output:
//   <out-dir>/taxonomy-db.bin.gz     gzipped binary lookup tables (see format below)
//   <out-dir>/taxonomy-db.meta.json  version info consumed by the app loader
//
// The binary is gzipped before writing (~4x smaller: ~110MB -> ~28MB for the
// full NCBI taxdump) for two reasons: it's a much smaller one-time download
// for users, and — more importantly — GitHub rejects any single committed
// file over 100MB outright, which the raw binary exceeds. The app loader
// decompresses it client-side with DecompressionStream, the same approach
// ../src/parse/compressed.js already uses for uploaded .gz files.
//
// Not run by the app itself and not part of the browser build — this is a
// maintainer/contributor tool. Re-run it whenever the taxonomy database
// needs refreshing, then commit the two output files under data/ (served
// same-origin by GitHub Pages — GitHub Release assets don't send CORS
// headers, so fetch() from the app can't use them; see the note on
// TAXONOMY_DB_BASE_URL in src/app.js).
//
// Binary format (little-endian). Typed arrays are ordered widest-element
// first (4-byte, then 2-byte, then 1-byte) so every array starts on a
// 4-byte boundary without padding — the fixed header is 16 bytes, and every
// preceding array's byte length is itself a multiple of its own element
// size, which keeps the next array aligned. The two variable-length text
// blobs are read as raw bytes (via TextDecoder), so they carry no alignment
// requirement and are placed last.
//
//   magic          "CBTX" (4 bytes)
//   formatVersion  uint32
//   maxTaxid       uint32                  (arrays below are sized maxTaxid+1)
//   rankTableLen   uint32                  (byte length of rankTableBlob)
//   parentTaxid    Int32Array[maxTaxid+1]  (-1 = no entry / no parent)
//   nameOffset     Uint32Array[maxTaxid+1] (0xFFFFFFFF = no scientific name)
//   nameLength     Uint16Array[maxTaxid+1]
//   rankId         Uint8Array[maxTaxid+1]  (255 = unknown/no entry)
//   rankTableBlob  rankTableLen bytes      (rank names, NUL-separated, index = rank id)
//   nameBlobLen    uint32
//   nameBlob       nameBlobLen bytes       (UTF-8 scientific names, concatenated, no separators)

import { writeFile, mkdir } from "node:fs/promises";
import { gunzipSync, gzipSync } from "node:zlib";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_URL = "https://ftp.ncbi.nlm.nih.gov/pub/taxonomy/taxdump.tar.gz";
const FORMAT_VERSION = 1;

function parseArgs(argv) {
  const args = { outDir: "data", url: DEFAULT_URL };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out-dir") args.outDir = argv[++i];
    else if (argv[i] === "--url") args.url = argv[++i];
  }
  return args;
}

async function downloadTarGz(url) {
  console.log(`Downloading ${url} ...`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
  console.log(`Downloaded ${(buf.length / 1e6).toFixed(1)} MB, decompressing ...`);
  return gunzipSync(buf);
}

/** Minimal ustar reader: returns a Map of filename -> Buffer for the entries we need. */
function extractTarEntries(tarBuf, wantedNames) {
  const wanted = new Set(wantedNames);
  const found = new Map();
  let offset = 0;
  while (offset + 512 <= tarBuf.length && found.size < wanted.size) {
    const header = tarBuf.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break; // end-of-archive marker
    const name = header.toString("utf8", 0, 100).replace(/\0.*$/, "");
    const sizeOctal = header.toString("utf8", 124, 136).replace(/\0.*$/, "").trim();
    const size = parseInt(sizeOctal, 8) || 0;
    const dataStart = offset + 512;
    const baseName = name.split("/").pop();
    if (wanted.has(baseName)) {
      found.set(baseName, tarBuf.subarray(dataStart, dataStart + size));
    }
    const blocks = Math.ceil(size / 512);
    offset = dataStart + blocks * 512;
  }
  return found;
}

function parseNodesDmp(buf) {
  const text = buf.toString("utf8");
  const nodes = new Map(); // taxid -> { parent, rank }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const fields = line.split("\t|\t");
    const taxid = parseInt(fields[0], 10);
    const parent = parseInt(fields[1], 10);
    const rank = fields[2]?.replace(/\t?\|\s*$/, "").trim();
    if (Number.isFinite(taxid)) nodes.set(taxid, { parent, rank });
  }
  return nodes;
}

function parseNamesDmp(buf) {
  const text = buf.toString("utf8");
  const names = new Map(); // taxid -> scientific name
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const fields = line.split("\t|\t");
    const taxid = parseInt(fields[0], 10);
    const nameTxt = fields[1];
    const nameClass = fields[3]?.replace(/\t?\|\s*$/, "").trim();
    if (Number.isFinite(taxid) && nameClass === "scientific name") {
      names.set(taxid, nameTxt);
    }
  }
  return names;
}

function buildBinary(nodes, names) {
  let maxTaxid = 0;
  for (const taxid of nodes.keys()) if (taxid > maxTaxid) maxTaxid = taxid;

  const rankIds = new Map(); // rank name -> id
  const rankNames = [];
  function rankIdOf(rank) {
    if (!rank) return 255;
    if (!rankIds.has(rank)) {
      rankIds.set(rank, rankNames.length);
      rankNames.push(rank);
    }
    return rankIds.get(rank);
  }

  const parentTaxid = new Int32Array(maxTaxid + 1).fill(-1);
  const rankId = new Uint8Array(maxTaxid + 1).fill(255);
  const nameOffset = new Uint32Array(maxTaxid + 1).fill(0xffffffff);
  const nameLength = new Uint16Array(maxTaxid + 1);

  for (const [taxid, { parent, rank }] of nodes) {
    parentTaxid[taxid] = Number.isFinite(parent) ? parent : -1;
    rankId[taxid] = rankIdOf(rank);
  }

  const nameChunks = [];
  let nameBlobOffset = 0;
  for (let taxid = 0; taxid <= maxTaxid; taxid++) {
    const name = names.get(taxid);
    if (name === undefined) continue;
    const encoded = Buffer.from(name, "utf8");
    nameOffset[taxid] = nameBlobOffset;
    nameLength[taxid] = encoded.length;
    nameChunks.push(encoded);
    nameBlobOffset += encoded.length;
  }
  const nameBlob = Buffer.concat(nameChunks, nameBlobOffset);
  const rankTableBlob = Buffer.from(rankNames.join("\0") + (rankNames.length ? "\0" : ""), "utf8");

  const headerLen = 16; // magic + formatVersion + maxTaxid + rankTableLen
  const arraysLen = parentTaxid.byteLength + nameOffset.byteLength + nameLength.byteLength + rankId.byteLength;
  const out = Buffer.alloc(headerLen + arraysLen + rankTableBlob.length + 4 + nameBlob.length);

  let p = 0;
  out.write("CBTX", p, "ascii"); p += 4;
  out.writeUInt32LE(FORMAT_VERSION, p); p += 4;
  out.writeUInt32LE(maxTaxid, p); p += 4;
  out.writeUInt32LE(rankTableBlob.length, p); p += 4;

  Buffer.from(parentTaxid.buffer, parentTaxid.byteOffset, parentTaxid.byteLength).copy(out, p); p += parentTaxid.byteLength;
  Buffer.from(nameOffset.buffer, nameOffset.byteOffset, nameOffset.byteLength).copy(out, p); p += nameOffset.byteLength;
  Buffer.from(nameLength.buffer, nameLength.byteOffset, nameLength.byteLength).copy(out, p); p += nameLength.byteLength;
  Buffer.from(rankId.buffer, rankId.byteOffset, rankId.byteLength).copy(out, p); p += rankId.byteLength;

  rankTableBlob.copy(out, p); p += rankTableBlob.length;
  out.writeUInt32LE(nameBlob.length, p); p += 4;
  nameBlob.copy(out, p); p += nameBlob.length;

  return { buffer: out, maxTaxid, taxidCount: nodes.size, namedCount: names.size };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const tarBuf = await downloadTarGz(args.url);

  console.log("Extracting nodes.dmp and names.dmp ...");
  const entries = extractTarEntries(tarBuf, ["nodes.dmp", "names.dmp"]);
  if (!entries.has("nodes.dmp") || !entries.has("names.dmp")) {
    throw new Error("taxdump archive did not contain nodes.dmp and names.dmp");
  }

  console.log("Parsing nodes.dmp ...");
  const nodes = parseNodesDmp(entries.get("nodes.dmp"));
  console.log(`  ${nodes.size} nodes`);

  console.log("Parsing names.dmp ...");
  const names = parseNamesDmp(entries.get("names.dmp"));
  console.log(`  ${names.size} scientific names`);

  console.log("Building binary lookup tables ...");
  const { buffer, maxTaxid, taxidCount, namedCount } = buildBinary(nodes, names);

  console.log("Gzipping ...");
  const gzipped = gzipSync(buffer, { level: 9 });

  await mkdir(args.outDir, { recursive: true });
  const binGzPath = path.join(args.outDir, "taxonomy-db.bin.gz");
  const metaPath = path.join(args.outDir, "taxonomy-db.meta.json");

  await writeFile(binGzPath, gzipped);
  const meta = {
    formatVersion: FORMAT_VERSION,
    sourceUrl: args.url,
    builtAt: new Date().toISOString(),
    maxTaxid,
    taxidCount,
    namedCount,
    byteLength: buffer.length,
    gzipByteLength: gzipped.length,
  };
  await writeFile(metaPath, JSON.stringify(meta, null, 2));

  console.log(`Wrote ${binGzPath} (${(gzipped.length / 1e6).toFixed(1)} MB gzipped, ${(buffer.length / 1e6).toFixed(1)} MB uncompressed)`);
  console.log(`Wrote ${metaPath}`);
  console.log("Commit both files (git add data/taxonomy-db.bin.gz data/taxonomy-db.meta.json) to publish this update.");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export { downloadTarGz, extractTarEntries, parseNodesDmp, parseNamesDmp, buildBinary };
