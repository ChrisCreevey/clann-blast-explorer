// app.js — upload glue: File(s) → parse() → explorer.
//
// Pure client side. Files are read with FileReader; nothing leaves the browser.

import { parse, ColumnMappingNeeded } from "./parse/index.js";
import { parseFasta } from "./parse/fasta.js";
import { mountExplorer } from "./explorer.js";
import { renderColumnMapping } from "./render/column-mapping.js";
import { extractNamesDmpFromTarGz, parseNamesDmp } from "./parse/taxdump.js";
import { decompressIfNeeded } from "./parse/compressed.js";

const explorerEl = document.getElementById("explorer");
const columnMappingEl = document.getElementById("columnMapping");
const fileInput = document.getElementById("fileInput");
const empty = document.getElementById("empty");
const drop = document.getElementById("drop");
const errBox = document.getElementById("err");
const wrap = document.getElementById("wrap");
const hTitle = document.getElementById("hTitle");
const hMeta = document.getElementById("hMeta");

let handle = null; // the live explorer instance, once a file is loaded

function showError(msg) {
  errBox.textContent = msg;
  errBox.style.display = "block";
  clearTimeout(showError._t);
  showError._t = setTimeout(() => (errBox.style.display = "none"), 6000);
}

function loadData(data, name) {
  empty.style.display = "none";
  columnMappingEl.style.display = "none";
  explorerEl.style.display = "flex";
  explorerEl.style.flexDirection = "column";
  hTitle.textContent = name || "";
  hMeta.textContent = `${data.queries.length} queries · ${data.hits.length} hits · ${data.meta.format}`;
  if (handle) handle = handle.setData(data);
  else handle = mountExplorer(explorerEl, data);
  // A new forward run invalidates any previously loaded reverse run / uploaded FASTA files.
  document.getElementById("rbhStatus").textContent =
    "Load a second (reverse) BLAST run to compute reciprocal best hits against the current (forward) run.";
  document.getElementById("rbhClearBtn").style.display = "none";
  document.getElementById("queryFastaStatus").textContent = "No query FASTA loaded.";
  document.getElementById("subjectFastaStatus").textContent = "No subject FASTA loaded.";
  document.getElementById("exportQueryFastaBtn").disabled = true;
  document.getElementById("exportSubjectFastaBtn").disabled = true;
  document.getElementById("taxdumpStatus").textContent = "No taxonomy mapping loaded.";
  document.getElementById("taxdumpControls").style.display = "none";
  document.getElementById("clearTaxdumpBtn").style.display = "none";
}

function openText(text, name) {
  try {
    const data = parse(text, { filename: name });
    loadData(data, name);
  } catch (err) {
    if (err instanceof ColumnMappingNeeded) {
      showColumnMapping(err, text, name);
      return;
    }
    showError(`Couldn't parse ${name}: ${err && err.message ? err.message : err}`);
  }
}

function showColumnMapping(err, text, name) {
  empty.style.display = "none";
  explorerEl.style.display = "none";
  columnMappingEl.style.display = "block";
  renderColumnMapping(columnMappingEl, {
    message: err.message,
    previewRows: err.previewRows,
    onApply(columns) {
      try {
        const data = parse(text, { filename: name, columns });
        loadData(data, name);
      } catch (retryErr) {
        showError(`Still couldn't parse ${name} with that mapping: ${retryErr && retryErr.message ? retryErr.message : retryErr}`);
      }
    },
    onCancel() {
      columnMappingEl.style.display = "none";
      if (handle) explorerEl.style.display = "flex"; // a dataset was already loaded — go back to it
      else empty.style.display = "block";
    },
  });
}

/** Read a File as text, transparently gunzipping/unzipping it first if it's compressed. */
async function readTextFile(file) {
  const decompressed = await decompressIfNeeded(file);
  return decompressed || { text: await file.text(), filename: file.name };
}

async function openFile(file) {
  if (!file) return;
  let text, name;
  try { ({ text, filename: name } = await readTextFile(file)); }
  catch (err) { showError(`Couldn't read ${file.name}: ${err && err.message ? err.message : err}`); return; }
  openText(text, name);
}

// --- file input / buttons ---
fileInput.addEventListener("change", (e) => {
  const f = e.target.files && e.target.files[0];
  openFile(f);
  fileInput.value = ""; // allow re-opening the same filename
});
const pick = () => fileInput.click();
document.getElementById("uploadBtn").addEventListener("click", pick);
document.getElementById("emptyOpen").addEventListener("click", pick);

// --- RBH mode: load a second (reverse) BLAST run ---
const reverseFileInput = document.getElementById("reverseFileInput");
const rbhStatus = document.getElementById("rbhStatus");
const rbhClearBtn = document.getElementById("rbhClearBtn");
document.getElementById("rbhLoadBtn").addEventListener("click", () => reverseFileInput.click());
reverseFileInput.addEventListener("change", async (e) => {
  const f = e.target.files && e.target.files[0];
  reverseFileInput.value = "";
  if (!f || !handle) return;
  let text, name;
  try { ({ text, filename: name } = await readTextFile(f)); }
  catch (err) { showError(`Couldn't read ${f.name}: ${err && err.message ? err.message : err}`); return; }
  try {
    const reverseData = parse(text, { filename: name });
    handle.setReverseData(reverseData, name);
    rbhStatus.textContent = `Reverse run: ${name} (${reverseData.queries.length} queries, ${reverseData.hits.length} hits)`;
    rbhClearBtn.style.display = "";
  } catch (err) {
    showError(`Couldn't parse reverse file ${name}: ${err && err.message ? err.message : err}`);
  }
});
rbhClearBtn.addEventListener("click", () => {
  if (handle) handle.setReverseData(null);
  rbhStatus.textContent = "Load a second (reverse) BLAST run to compute reciprocal best hits against the current (forward) run.";
  rbhClearBtn.style.display = "none";
});

// --- Phase 4: upload query/subject FASTA for ID-matched export ---
async function loadFastaInto(file, setter) {
  if (!file || !handle) return;
  let text, name;
  try { ({ text, filename: name } = await readTextFile(file)); }
  catch (err) { showError(`Couldn't read ${file.name}: ${err && err.message ? err.message : err}`); return; }
  try {
    const records = parseFasta(text);
    if (!records.length) throw new Error("no FASTA records found");
    setter(records, name);
  } catch (err) {
    showError(`Couldn't parse ${name} as FASTA: ${err && err.message ? err.message : err}`);
  }
}
const queryFastaInput = document.getElementById("queryFastaInput");
document.getElementById("loadQueryFastaBtn").addEventListener("click", () => queryFastaInput.click());
queryFastaInput.addEventListener("change", (e) => {
  const f = e.target.files && e.target.files[0];
  queryFastaInput.value = "";
  loadFastaInto(f, (records, name) => handle.setQueryFasta(records, name));
});

const subjectFastaInput = document.getElementById("subjectFastaInput");
document.getElementById("loadSubjectFastaBtn").addEventListener("click", () => subjectFastaInput.click());
subjectFastaInput.addEventListener("change", (e) => {
  const f = e.target.files && e.target.files[0];
  subjectFastaInput.value = "";
  loadFastaInto(f, (records, name) => handle.setSubjectFasta(records, name));
});

// --- taxonomy mapping: upload NCBI names.dmp (or taxdump.tar.gz, extracted client-side) ---
const taxdumpInput = document.getElementById("taxdumpInput");
const taxdumpStatus = document.getElementById("taxdumpStatus");
const loadTaxdumpBtn = document.getElementById("loadTaxdumpBtn");
document.getElementById("loadTaxdumpBtn").addEventListener("click", () => taxdumpInput.click());
taxdumpInput.addEventListener("change", async (e) => {
  const f = e.target.files && e.target.files[0];
  taxdumpInput.value = "";
  if (!f || !handle) return;
  taxdumpStatus.textContent = "Parsing… this can take a moment for the full taxdump.";
  loadTaxdumpBtn.disabled = true;
  try {
    let text;
    if (/\.(tar\.gz|tgz)$/i.test(f.name)) {
      text = await extractNamesDmpFromTarGz(await f.arrayBuffer());
    } else {
      const decompressed = await decompressIfNeeded(f); // handles a plain names.dmp.gz or .zip
      text = decompressed ? decompressed.text : await f.text();
    }
    const taxonMap = parseNamesDmp(text);
    if (!taxonMap.size) throw new Error("no scientific names found — is this a names.dmp file?");
    handle.setTaxonMap(taxonMap, f.name);
  } catch (err) {
    showError(`Couldn't load taxonomy dump ${f.name}: ${err && err.message ? err.message : err}`);
    taxdumpStatus.textContent = "No taxonomy mapping loaded.";
  } finally {
    loadTaxdumpBtn.disabled = false;
  }
});

// --- paste tabular text anywhere (except into a field) to load it ---
window.addEventListener("paste", (e) => {
  const t = e.target;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return; // don't hijack form paste
  const text = e.clipboardData && e.clipboardData.getData("text");
  if (!text || !/\t/.test(text)) return; // needs to at least look like tab-delimited data
  e.preventDefault();
  openText(text, "pasted data");
});

// --- draggable sidebar width (shell-level) ---
(() => {
  const side = document.getElementById("side");
  const resizer = document.getElementById("sideResize");
  if (!side || !resizer) return;
  const MIN = 200, MAX = 620;
  const saved = +localStorage.getItem("clannBlastSideW");
  if (saved >= MIN && saved <= MAX) side.style.width = saved + "px";
  let dragging = false;
  resizer.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    dragging = true;
    try { resizer.setPointerCapture(e.pointerId); } catch { /* non-pointer env */ }
    resizer.classList.add("drag");
    document.body.style.userSelect = "none";
  });
  resizer.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const w = Math.max(MIN, Math.min(MAX, e.clientX - side.getBoundingClientRect().left));
    side.style.width = w + "px";
  });
  const end = (e) => {
    if (!dragging) return;
    dragging = false;
    try { resizer.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    resizer.classList.remove("drag");
    document.body.style.userSelect = "";
    localStorage.setItem("clannBlastSideW", parseInt(side.style.width, 10) || "");
  };
  resizer.addEventListener("pointerup", end);
  resizer.addEventListener("pointercancel", end);
  resizer.addEventListener("dblclick", () => { side.style.width = ""; localStorage.removeItem("clannBlastSideW"); });
})();

// --- light/dark toggle (shell-level: active even before a file is loaded) ---
document.getElementById("themeBtn").addEventListener("click", () => {
  const r = document.documentElement;
  r.dataset.theme = r.dataset.theme === "dark" ? "light" : "dark";
});

// --- drag & drop over the canvas ---
let dragDepth = 0;
const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes("Files");
wrap.addEventListener("dragenter", (e) => { if (!hasFiles(e)) return; e.preventDefault(); if (dragDepth++ === 0) drop.classList.add("on"); });
wrap.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
wrap.addEventListener("dragleave", (e) => { if (!hasFiles(e)) return; if (--dragDepth <= 0) { dragDepth = 0; drop.classList.remove("on"); } });
wrap.addEventListener("drop", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault(); dragDepth = 0; drop.classList.remove("on");
  const f = e.dataTransfer.files && e.dataTransfer.files[0];
  openFile(f);
});

// --- footer: show the repo's live star count next to the "Like it?" button ---
fetch("https://api.github.com/repos/ChrisCreevey/clann-blast-explorer")
  .then((r) => (r.ok ? r.json() : null))
  .then((d) => {
    const c = document.getElementById("starCount");
    if (c && d && d.stargazers_count > 0) { c.textContent = d.stargazers_count; c.hidden = false; }
  })
  .catch(() => {});

// --- optional deep link: index.html?data=examples/... ---
const q = new URLSearchParams(location.search).get("data");
if (q) {
  fetch(q)
    .then((r) => { if (!r.ok) throw new Error(r.status + " " + r.statusText); return r.text(); })
    .then((text) => openText(text, q.split("/").pop()))
    .catch((err) => showError(`Couldn't load ${q}: ${err.message}`));
}
