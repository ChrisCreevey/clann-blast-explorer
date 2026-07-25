// compressed.js — transparently accept gzip- or zip-compressed uploads
// (BLAST tabular output, FASTA, ...), decompressing entirely client-side with
// native browser APIs. No dependencies, nothing leaves the browser.

function looksLikeGzip(bytes) {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}
function looksLikeZip(bytes) {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

async function gunzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Search backward for the End Of Central Directory record (tolerates a trailing zip comment). */
function findEndOfCentralDirectory(bytes) {
  const EOCD_SIG = 0x06054b50;
  const maxCommentLen = 65535;
  const searchStart = Math.max(0, bytes.length - 22 - maxCommentLen);
  for (let i = bytes.length - 22; i >= searchStart; i--) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + i, 22);
    if (view.getUint32(0, true) === EOCD_SIG) {
      return {
        totalEntries: view.getUint16(10, true),
        centralDirOffset: view.getUint32(16, true),
      };
    }
  }
  return null;
}

/** List every file entry in a ZIP archive's central directory. */
export function listZipEntries(bytes) {
  const eocd = findEndOfCentralDirectory(bytes);
  if (!eocd) throw new Error("Not a valid ZIP archive (no end-of-central-directory record found).");
  const decoder = new TextDecoder();
  const entries = [];
  let offset = eocd.centralDirOffset;
  for (let i = 0; i < eocd.totalEntries; i++) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 46);
    if (view.getUint32(0, true) !== 0x02014b50) break; // central file header signature
    const compressionMethod = view.getUint16(10, true);
    const compressedSize = view.getUint32(20, true);
    const fileNameLength = view.getUint16(28, true);
    const extraFieldLength = view.getUint16(30, true);
    const fileCommentLength = view.getUint16(32, true);
    const localHeaderOffset = view.getUint32(42, true);
    const nameStart = offset + 46;
    const name = decoder.decode(bytes.subarray(nameStart, nameStart + fileNameLength));
    entries.push({ name, compressionMethod, compressedSize, localHeaderOffset });
    offset = nameStart + fileNameLength + extraFieldLength + fileCommentLength;
  }
  return entries;
}

/** Extract one ZIP entry's decompressed bytes. */
export async function extractZipEntry(bytes, entry) {
  const localView = new DataView(bytes.buffer, bytes.byteOffset + entry.localHeaderOffset, 30);
  if (localView.getUint32(0, true) !== 0x04034b50) throw new Error("Corrupt ZIP local file header.");
  const nameLen = localView.getUint16(26, true);
  const extraLen = localView.getUint16(28, true);
  const dataStart = entry.localHeaderOffset + 30 + nameLen + extraLen;
  const compressed = bytes.subarray(dataStart, dataStart + entry.compressedSize);
  if (entry.compressionMethod === 0) return compressed; // stored, no compression
  if (entry.compressionMethod === 8) return inflateRaw(compressed);
  throw new Error(`Unsupported ZIP compression method (${entry.compressionMethod}) — only "stored" and "deflate" are supported.`);
}

/**
 * If `file` is gzip- or zip-compressed (detected by magic bytes, not
 * extension), decompress it and return { text, filename } with the
 * compression wrapper's name stripped. Otherwise returns null — the caller
 * should read the file as plain text itself.
 */
export async function decompressIfNeeded(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());

  if (looksLikeGzip(bytes)) {
    const out = await gunzip(bytes);
    return { text: new TextDecoder().decode(out), filename: file.name.replace(/\.gz$/i, "") };
  }

  if (looksLikeZip(bytes)) {
    const entries = listZipEntries(bytes).filter((e) => !e.name.endsWith("/"));
    if (!entries.length) throw new Error("This ZIP archive has no files in it.");
    const chosen = entries.find((e) => /\.(tsv|tab|txt|blast|m8|out|fasta|fa|fna|faa)$/i.test(e.name)) || entries[0];
    const out = await extractZipEntry(bytes, chosen);
    return { text: new TextDecoder().decode(out), filename: chosen.name.split("/").pop() };
  }

  return null;
}
