// app.js — upload glue: File(s) → parse() → explorer.
//
// Pure client side. Files are read with FileReader; nothing leaves the browser.

import { parse, ColumnMappingNeeded } from "./parse/index.js";
import { mountExplorer } from "./explorer.js";

const explorerEl = document.getElementById("explorer");
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
  explorerEl.style.display = "flex";
  explorerEl.style.flexDirection = "column";
  hTitle.textContent = name || "";
  hMeta.textContent = `${data.queries.length} queries · ${data.hits.length} hits · ${data.meta.format}`;
  if (handle) handle.setData(data);
  else handle = mountExplorer(explorerEl, data);
  // A new forward run invalidates any previously loaded reverse run.
  document.getElementById("rbhStatus").textContent =
    "Load a second (reverse) BLAST run to compute reciprocal best hits against the current (forward) run.";
  document.getElementById("rbhClearBtn").style.display = "none";
}

function openText(text, name) {
  try {
    const data = parse(text, { filename: name });
    loadData(data, name);
  } catch (err) {
    if (err instanceof ColumnMappingNeeded) {
      // TODO: Phase 1 manual column-mapping UI; for now surface the reason clearly.
      showError(`Couldn't detect columns in ${name}: ${err.message}`);
      return;
    }
    showError(`Couldn't parse ${name}: ${err && err.message ? err.message : err}`);
  }
}

async function openFile(file) {
  if (!file) return;
  let text;
  try { text = await file.text(); }
  catch { showError(`Couldn't read ${file.name}`); return; }
  openText(text, file.name);
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
  let text;
  try { text = await f.text(); }
  catch { showError(`Couldn't read ${f.name}`); return; }
  try {
    const reverseData = parse(text, { filename: f.name });
    handle.setReverseData(reverseData, f.name);
    rbhStatus.textContent = `Reverse run: ${f.name} (${reverseData.queries.length} queries, ${reverseData.hits.length} hits)`;
    rbhClearBtn.style.display = "";
  } catch (err) {
    showError(`Couldn't parse reverse file ${f.name}: ${err && err.message ? err.message : err}`);
  }
});
rbhClearBtn.addEventListener("click", () => {
  if (handle) handle.setReverseData(null);
  rbhStatus.textContent = "Load a second (reverse) BLAST run to compute reciprocal best hits against the current (forward) run.";
  rbhClearBtn.style.display = "none";
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
