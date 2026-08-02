// taxonomy-db.js — loads the prebuilt NCBI taxonomy lookup (see
// tools/build-taxonomy-db.js for the binary format and build process) and
// resolves a taxid to its full lineage (kingdom..species).
//
// This is a separate, optional layer on top of ../parse/taxdump.js: that
// module lets a user manually load their own taxdump.tar.gz to backfill
// missing sscinames on hits (name-only, no lineage). This module instead
// fetches a prebuilt binary lookup once (from the same-origin data/
// directory — see the note on TAXONOMY_DB_BASE_URL in app.js for why it's
// not a GitHub Release asset: those don't send CORS headers, so cross-origin
// fetch() is blocked by the browser regardless of app code), caches it in
// IndexedDB, and can walk the full parent chain to produce
// kingdom/phylum/class/order/family/genus/species — used for hierarchical
// taxonomy views rather than a flat species label.
//
// Everything here is client-side: one network fetch on first use per
// browser, then reads straight from IndexedDB on every later visit.

const DB_NAME = "clann-blast-explorer";
const STORE_NAME = "taxonomy-db";
const CACHE_KEY = "current";

const MAGIC = "CBTX";

/** Canonical lineage ranks this module reports, in root-to-leaf order. */
export const LINEAGE_RANKS = ["superkingdom", "kingdom", "phylum", "class", "order", "family", "genus", "species"];

/**
 * NCBI taxdump rank names that map onto a LINEAGE_RANKS bucket under a
 * different name. Current taxdump releases use "domain" where older ones
 * (and most literature) say "superkingdom" — both are accepted and reported
 * under the canonical "superkingdom" key.
 */
const RANK_ALIASES = { domain: "superkingdom" };

/**
 * Decode a taxonomy-db.bin ArrayBuffer into typed-array views plus a text
 * decoder for names, per the format documented in tools/build-taxonomy-db.js.
 * Pure function, no I/O — safe to unit test directly.
 */
export function decodeTaxonomyDb(arrayBuffer) {
  const buf = new DataView(arrayBuffer);
  let p = 0;
  const magic = String.fromCharCode(buf.getUint8(0), buf.getUint8(1), buf.getUint8(2), buf.getUint8(3));
  if (magic !== MAGIC) throw new Error(`Not a taxonomy-db file (bad magic: "${magic}")`);
  p += 4;
  const formatVersion = buf.getUint32(p, true); p += 4;
  const maxTaxid = buf.getUint32(p, true); p += 4;
  const rankTableLen = buf.getUint32(p, true); p += 4;

  const n = maxTaxid + 1;
  const parentTaxid = new Int32Array(arrayBuffer, p, n); p += n * 4;
  const nameOffset = new Uint32Array(arrayBuffer, p, n); p += n * 4;
  const nameLength = new Uint16Array(arrayBuffer, p, n); p += n * 2;
  const rankId = new Uint8Array(arrayBuffer, p, n); p += n;

  const rankTableBlob = new Uint8Array(arrayBuffer, p, rankTableLen); p += rankTableLen;
  const ranks = new TextDecoder().decode(rankTableBlob).split("\0").filter(Boolean);

  const nameBlobLen = buf.getUint32(p, true); p += 4;
  const nameBlob = new Uint8Array(arrayBuffer, p, nameBlobLen); p += nameBlobLen;
  const nameDecoder = new TextDecoder();

  return { formatVersion, maxTaxid, ranks, parentTaxid, nameOffset, nameLength, rankId, nameBlob, nameDecoder };
}

function nameForTaxid(db, taxid) {
  if (taxid < 0 || taxid > db.maxTaxid) return undefined;
  const off = db.nameOffset[taxid];
  if (off === 0xffffffff) return undefined;
  const len = db.nameLength[taxid];
  return db.nameDecoder.decode(db.nameBlob.subarray(off, off + len));
}

function rankForTaxid(db, taxid) {
  if (taxid < 0 || taxid > db.maxTaxid) return undefined;
  const id = db.rankId[taxid];
  return id === 255 ? undefined : db.ranks[id];
}

/**
 * Walk the parent chain from `taxid` to the root, returning a
 * { superkingdom, kingdom, phylum, ..., species, taxid } object with only
 * the canonical LINEAGE_RANKS populated (other ranks in the chain, e.g.
 * "no rank" or "subfamily", are skipped). Returns null for an unknown taxid.
 */
export function resolveLineage(db, taxid, { maxDepth = 64 } = {}) {
  taxid = Number(taxid);
  if (!Number.isFinite(taxid) || taxid < 0 || taxid > db.maxTaxid) return null;
  if (db.parentTaxid[taxid] === -1 && nameForTaxid(db, taxid) === undefined) return null;

  const lineage = { taxid };
  let current = taxid;
  let steps = 0;
  const rankSet = new Set(LINEAGE_RANKS);
  while (steps < maxDepth) {
    const rawRank = rankForTaxid(db, current);
    const rank = rawRank && (RANK_ALIASES[rawRank] ?? rawRank);
    const name = nameForTaxid(db, current);
    if (rank && rankSet.has(rank) && name && lineage[rank] === undefined) {
      lineage[rank] = name;
    }
    const parent = db.parentTaxid[current];
    if (parent === -1 || parent === current) break; // root node is its own parent
    current = parent;
    steps++;
  }
  return lineage;
}

export function resolveLineageBatch(db, taxids, opts) {
  const out = new Map();
  for (const t of taxids) out.set(t, resolveLineage(db, t, opts));
  return out;
}

/**
 * Backfill sscinames/sskingdoms on hits that have a staxids value but no
 * name yet, using a loaded taxonomy db handle (as returned by
 * loadTaxonomyDb — anything with a resolveLineage(taxid) method works).
 * Mirrors ../parse/taxdump.js's enrichHitsWithTaxonomy, but resolves a full
 * lineage rather than a flat name lookup. Never overwrites existing
 * sscinames. Returns a new hits array (originals untouched) and the count
 * of hits that were filled in.
 */
export function enrichHitsWithLineage(hits, taxonomyDb) {
  let filledCount = 0;
  const enriched = hits.map((h) => {
    if (h.sscinames || !h.staxids) return h;
    const ids = Array.isArray(h.staxids) ? h.staxids : [h.staxids];
    const lineages = ids.map((id) => taxonomyDb.resolveLineage(id)).filter(Boolean);
    if (!lineages.length) return h;
    const names = lineages.map((l) => l.species || l.genus).filter(Boolean);
    const kingdoms = lineages.map((l) => l.superkingdom || l.kingdom).filter(Boolean);
    if (!names.length && !kingdoms.length) return h;
    filledCount++;
    return {
      ...h,
      ...(names.length ? { sscinames: names.join("; ") } : {}),
      ...(kingdoms.length ? { sskingdoms: kingdoms.join("; ") } : {}),
    };
  });
  return { hits: enriched, filledCount };
}

// --- IndexedDB caching -------------------------------------------------

function openCacheDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  const db = await openCacheDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, value) {
  const db = await openCacheDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbDelete(key) {
  const db = await openCacheDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Cached { meta, bytes: ArrayBuffer } from a previous load, or null if nothing is cached. */
export async function getCachedTaxonomyDb() {
  if (typeof indexedDB === "undefined") return null;
  return idbGet(CACHE_KEY);
}

export async function clearCachedTaxonomyDb() {
  if (typeof indexedDB === "undefined") return;
  await idbDelete(CACHE_KEY);
}

async function fetchWithProgress(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
  const total = Number(res.headers.get("content-length")) || 0;
  if (!onProgress || !res.body) return res.arrayBuffer();

  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress({ received, total });
  }
  const buf = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) { buf.set(chunk, offset); offset += chunk.length; }
  return buf.buffer;
}

/** The committed data/taxonomy-db.bin.gz is gzipped (~4x smaller); decompress after fetching. */
async function gunzip(arrayBuffer) {
  const stream = new Blob([arrayBuffer]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).arrayBuffer();
}

/**
 * Fetch just the small meta.json from `baseUrl` to check whether a newer
 * taxonomy database is published, without downloading the full binary.
 */
export async function checkTaxonomyDbUpdate(baseUrl) {
  const res = await fetch(`${baseUrl}/taxonomy-db.meta.json`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to fetch meta.json: ${res.status} ${res.statusText}`);
  const remoteMeta = await res.json();
  const cached = await getCachedTaxonomyDb();
  const cachedMeta = cached?.meta ?? null;
  const hasUpdate = !cachedMeta || cachedMeta.builtAt !== remoteMeta.builtAt;
  return { hasUpdate, remoteMeta, cachedMeta };
}

/**
 * Load a ready-to-use taxonomy database: from IndexedDB cache when present
 * (no network call), otherwise downloads from `baseUrl` (a same-origin path
 * serving taxonomy-db.bin.gz + taxonomy-db.meta.json — must be same-origin,
 * since GitHub Release assets don't send CORS headers), decompresses it,
 * and caches the decompressed result for next time (so later loads skip
 * decompression too). Pass `force: true` to re-download and overwrite the
 * cache even if one is already present.
 *
 * Returns { meta, fromCache, resolveLineage(taxid), resolveLineageBatch(taxids) }.
 */
export async function loadTaxonomyDb(baseUrl, { force = false, onProgress } = {}) {
  if (!force) {
    const cached = await getCachedTaxonomyDb();
    if (cached) {
      const db = decodeTaxonomyDb(cached.bytes);
      return {
        meta: cached.meta,
        fromCache: true,
        resolveLineage: (taxid, opts) => resolveLineage(db, taxid, opts),
        resolveLineageBatch: (taxids, opts) => resolveLineageBatch(db, taxids, opts),
      };
    }
  }

  const metaRes = await fetch(`${baseUrl}/taxonomy-db.meta.json`);
  if (!metaRes.ok) throw new Error(`Failed to fetch meta.json: ${metaRes.status} ${metaRes.statusText}`);
  const meta = await metaRes.json();

  const gzipped = await fetchWithProgress(`${baseUrl}/taxonomy-db.bin.gz`, onProgress);
  const bytes = await gunzip(gzipped);
  await idbSet(CACHE_KEY, { meta, bytes });

  const db = decodeTaxonomyDb(bytes);
  return {
    meta,
    fromCache: false,
    resolveLineage: (taxid, opts) => resolveLineage(db, taxid, opts),
    resolveLineageBatch: (taxids, opts) => resolveLineageBatch(db, taxids, opts),
  };
}
