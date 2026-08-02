// explorer.js — interactive UI: mountExplorer(container, data).
//
// Phase 1: query selector, ranked hit table, best-hit summary card, hit-span diagram.
// Phase 2: filters (sidebar), per-query summary table, distribution charts,
// identity-vs-coverage scatter, taxonomy chart — all live against the active thresholds.

import { querySummary, globalSummary, perQuerySummary, bestHits } from "./analysis/summary.js";
import { defaultThresholds, filterHits, computeQcov } from "./analysis/filters.js";
import { computeRBH } from "./analysis/rbh.js";
import { buildQueries } from "./parse/index.js";
import { buildTaxonPreview, enrichHitsWithTaxonomy } from "./parse/taxdump.js";
import { enrichHitsWithLineage } from "./analysis/taxonomy-db.js";
import { renderHitTable } from "./render/hit-table.js";
import { renderHitSpan } from "./render/hit-span.js";
import { renderHistogram, renderScatter, renderCategoryBars } from "./render/charts.js";
import { renderTaxonomyChart, taxonLabel } from "./render/taxonomy.js";
import { accessionLinkUrl } from "./parse/accession.js";
import { toDelimited, downloadText } from "../export/table-export.js";
import { querySeqEntriesFromHits, subjectSeqEntriesFromHits, matchedFastaEntries, toFasta, accessionListText } from "../export/fasta-export.js";

const EXPORT_COLS = [
  "qseqid", "sseqid", "pident", "length", "mismatch", "gapopen", "qstart", "qend", "sstart", "send",
  "evalue", "bitscore", "qcovs", "staxids", "sscinames", "stitle",
];

function fmtNum(v) {
  if (v === undefined || v === null) return "—";
  if (typeof v === "number" && !Number.isInteger(v)) {
    return Math.abs(v) < 0.001 ? v.toExponential(2) : v.toPrecision(4).replace(/\.?0+$/, "");
  }
  return String(v);
}

const FLAG_LABEL = { hit: "hit", weak: "weak", none: "no hit" };

function bestHitDlRows(h) {
  return [
    ["Subject", h.sseqid],
    ["% identity", fmtNum(h.pident)],
    ["Alignment length", fmtNum(h.length)],
    ["E-value", fmtNum(h.evalue)],
    ["Bit score", fmtNum(h.bitscore)],
    h.stitle ? ["Title", h.stitle] : null,
  ].filter(Boolean).map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("");
}

export function mountExplorer(container, data) {
  const querySelect = document.getElementById("querySelect");
  const queryMeta = document.getElementById("queryMeta");

  const filterInputs = {
    minPident: document.getElementById("fMinPident"),
    maxEvalue: document.getElementById("fMaxEvalue"),
    minBitscore: document.getElementById("fMinBitscore"),
    minLength: document.getElementById("fMinLength"),
    minQcov: document.getElementById("fMinQcov"),
    excludeSelfHits: document.getElementById("fExcludeSelf"),
    topNPerQuery: document.getElementById("fTopN"),
    taxonInclude: document.getElementById("fTaxonInclude"),
    taxonExclude: document.getElementById("fTaxonExclude"),
  };
  const resetBtn = document.getElementById("fReset");
  document.getElementById("fUndo").disabled = true;
  const rowTaxonInclude = document.getElementById("rowTaxonInclude");
  const rowTaxonExclude = document.getElementById("rowTaxonExclude");
  const taxonIncludeInput = filterInputs.taxonInclude;
  const taxonExcludeInput = filterInputs.taxonExclude;

  let showTaxonFilters = !!data.meta.hasTaxonomy;
  function updateTaxonFilterVisibility() {
    showTaxonFilters = !!data.meta.hasTaxonomy;
    [rowTaxonInclude, rowTaxonExclude, taxonIncludeInput, taxonExcludeInput].forEach((el) => {
      if (el) el.style.display = showTaxonFilters ? "" : "none";
    });
  }
  updateTaxonFilterVisibility();

  let thresholds = defaultThresholds();
  let filterHistory = []; // previous thresholds, for Undo
  let reverseData = null;
  let currentQseqid = null;
  let queryFastaRecords = null;
  let subjectFastaRecords = null;
  let taxonMap = null;
  let taxdumpFilename = null;
  let taxonomyDb = null;
  const pristineHits = data.hits; // hits as originally parsed, before any taxonomy enrichment — for Clear

  container.innerHTML = "";

  const modeBar = document.createElement("div");
  modeBar.className = "seg mode-switch";
  modeBar.innerHTML = `<button data-mode="query" class="on">Per-query</button><button data-mode="all">All queries</button>`;
  container.appendChild(modeBar);
  document.getElementById("querySection").style.display = ""; // a fresh file load always starts in Per-query mode

  const queryModeEl = document.createElement("div");
  queryModeEl.className = "mode-panel";
  container.appendChild(queryModeEl);

  const allModeEl = document.createElement("div");
  allModeEl.className = "mode-panel";
  allModeEl.style.display = "none";
  container.appendChild(allModeEl);

  // --- Per-query mode ---
  const bestHitCard = document.createElement("div");
  bestHitCard.className = "card best-hit-card";
  bestHitCard.innerHTML = "<h3 id=\"bestHitHeading\">Best hit</h3><div id=\"bestHitMount\"></div>";
  queryModeEl.appendChild(bestHitCard);

  const spanCard = document.createElement("div");
  spanCard.className = "card";
  spanCard.innerHTML = "<h3>HSP coverage</h3><div id=\"hitSpan\"></div>";
  queryModeEl.appendChild(spanCard);

  const tableCard = document.createElement("div");
  tableCard.className = "card";
  tableCard.innerHTML = "<h3>Hits for this query</h3><div id=\"hitTableMount\"></div>";
  queryModeEl.appendChild(tableCard);

  // --- All-queries mode ---
  const summaryCard = document.createElement("div");
  summaryCard.className = "card";
  summaryCard.innerHTML = "<h3>Run summary</h3><div id=\"runSummary\"></div>";
  allModeEl.appendChild(summaryCard);

  const perQueryCard = document.createElement("div");
  perQueryCard.className = "card";
  perQueryCard.innerHTML = "<h3>Per-query summary</h3><div id=\"perQueryMount\"></div>";
  allModeEl.appendChild(perQueryCard);

  const allHitsCard = document.createElement("div");
  allHitsCard.className = "card";
  allHitsCard.innerHTML = `<h3>All hits</h3>
    <div class="chart-controls">
      <select id="allHitsScope">
        <option value="all">all hits</option>
        <option value="best">best hit per query</option>
      </select>
    </div>
    <div id="allHitsMount"></div>`;
  allModeEl.appendChild(allHitsCard);

  const chartsCard = document.createElement("div");
  chartsCard.className = "card";
  chartsCard.innerHTML = `<h3>Distributions</h3>
    <div class="chart-controls">
      <select id="chartMetric">
        <option value="pident">% identity</option>
        <option value="evalue">e-value (log scale)</option>
        <option value="bitscore">bit score</option>
        <option value="length">alignment length</option>
        <option value="qcov">query coverage</option>
      </select>
      <select id="chartScope">
        <option value="best">best hit per query</option>
        <option value="all">all hits</option>
      </select>
    </div>
    <div id="chartMount"></div>`;
  allModeEl.appendChild(chartsCard);

  const scatterCard = document.createElement("div");
  scatterCard.className = "card";
  scatterCard.innerHTML = `<h3>% identity vs query coverage</h3>
    <div class="chart-controls">
      <select id="scatterColorBy">
        <option value="none">no colour</option>
        <option value="evalue">colour by e-value</option>
        <option value="taxon">colour by taxon</option>
      </select>
    </div>
    <div id="scatterMount"></div>`;
  allModeEl.appendChild(scatterCard);

  const taxCard = document.createElement("div");
  taxCard.className = "card";
  taxCard.innerHTML = "<h3>Taxonomy (best hit per query)</h3><div id=\"taxMount\"></div>";
  allModeEl.appendChild(taxCard);

  const rbhCard = document.createElement("div");
  rbhCard.className = "card";
  rbhCard.style.display = "none";
  rbhCard.innerHTML = `<h3>Reciprocal best hits</h3>
    <div id="rbhCounts"></div>
    <h4 style="margin-top:14px">Forward vs reverse % identity (reciprocal pairs)</h4>
    <div id="rbhScatterMount"></div>
    <h4 style="margin-top:14px">RBH pairs</h4>
    <button class="act" id="rbhExportBtn" style="width:auto">Download pair table (TSV)</button>
    <div id="rbhPairMount"></div>`;
  allModeEl.appendChild(rbhCard);

  let tableHandle = null;
  let allHitsTableHandle = null;

  const querySection = document.getElementById("querySection");

  function switchMode(newMode, qseqid) {
    modeBar.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.mode === newMode));
    queryModeEl.style.display = newMode === "query" ? "flex" : "none";
    allModeEl.style.display = newMode === "all" ? "flex" : "none";
    querySection.style.display = newMode === "query" ? "" : "none";
    if (qseqid) {
      querySelect.value = qseqid;
      renderQuery(qseqid);
    }
  }
  modeBar.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => switchMode(b.dataset.mode)));

  function readThresholds() {
    const maxEv = filterInputs.maxEvalue.value.trim();
    thresholds = {
      minPident: Number(filterInputs.minPident.value) || 0,
      maxEvalue: maxEv === "" ? null : Number(maxEv),
      minBitscore: Number(filterInputs.minBitscore.value) || 0,
      minLength: Number(filterInputs.minLength.value) || 0,
      minQcov: Number(filterInputs.minQcov.value) || 0,
      excludeSelfHits: filterInputs.excludeSelfHits.checked,
      topNPerQuery: Number(filterInputs.topNPerQuery.value) || 0,
      taxonInclude: showTaxonFilters ? filterInputs.taxonInclude.value.trim() : "",
      taxonExclude: showTaxonFilters ? filterInputs.taxonExclude.value.trim() : "",
    };
  }

  function renderRunSummary() {
    const s = globalSummary(data);
    const perQ = perQuerySummary(data, thresholds);
    const hit = perQ.filter((q) => q.flag === "hit").length;
    const weak = perQ.filter((q) => q.flag === "weak").length;
    const none = perQ.filter((q) => q.flag === "none").length;
    document.getElementById("runSummary").innerHTML =
      `<div class="row"><span>Queries</span><b>${s.totalQueries}</b></div>` +
      `<div class="row"><span>Total hits</span><b>${s.totalHits}</b></div>` +
      `<div class="row"><span>Passing current filters</span><b>${hit}</b></div>` +
      `<div class="row"><span>Weak (hits, none pass)</span><b>${weak}</b></div>` +
      `<div class="row"><span>No hit at all</span><b>${none}</b></div>`;
  }

  function renderPerQueryTable() {
    const rows = perQuerySummary(data, thresholds);
    const mount = document.getElementById("perQueryMount");
    mount.innerHTML = "";
    const wrap = document.createElement("div");
    wrap.className = "table-wrap";
    const table = document.createElement("table");
    table.className = "hit-table";
    table.innerHTML = `<thead><tr>
        <th>qseqid</th><th>hits</th><th>passing</th><th>best sseqid</th>
        <th>best %id</th><th>best e-value</th><th>flag</th>
      </tr></thead>`;
    const tbody = document.createElement("tbody");
    for (const r of rows) {
      const tr = document.createElement("tr");
      const tieCount = r.bestTied.length;
      const sseqidCell = tieCount === 0
        ? "—"
        : tieCount === 1
          ? r.bestTied[0].sseqid
          : `<span title="Tied at the top bit score: ${r.bestTied.map((h) => h.sseqid).join(", ")}">${r.bestTied[0].sseqid} (+${tieCount - 1} tied)</span>`;
      tr.innerHTML = `<td>${r.qseqid}</td><td class="num">${r.hitCount}</td><td class="num">${r.passingCount}</td>` +
        `<td>${sseqidCell}</td>` +
        `<td class="num">${r.best ? fmtNum(r.best.pident) : "—"}</td>` +
        `<td class="num">${r.best ? fmtNum(r.best.evalue) : "—"}</td>` +
        `<td><span class="flag-badge flag-${r.flag}">${FLAG_LABEL[r.flag]}</span></td>`;
      tr.classList.add("row-clickable");
      tr.addEventListener("click", () => switchMode("query", r.qseqid));
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    mount.appendChild(wrap);
  }

  function metricValues(hits, metric) {
    if (metric === "qcov") return hits.map(computeQcov);
    return hits.map((h) => h[metric]);
  }

  function renderCharts() {
    const metric = document.getElementById("chartMetric").value;
    const scope = document.getElementById("chartScope").value;
    const perQ = perQuerySummary(data, thresholds);
    const hits = scope === "best" ? perQ.map((q) => q.best).filter(Boolean) : filterHits(data.hits, thresholds);
    renderHistogram(document.getElementById("chartMount"), metricValues(hits, metric), { log10: metric === "evalue" });
  }

  function renderScatterChart() {
    const colorBy = document.getElementById("scatterColorBy").value;
    const hits = filterHits(data.hits, thresholds);
    const points = hits.map((h) => {
      const point = { x: h.pident, y: computeQcov(h), label: `${h.qseqid} vs ${h.sseqid}` };
      if (colorBy === "evalue" && typeof h.evalue === "number" && h.evalue > 0) {
        point.color = 1 - Math.min(1, Math.max(0, (Math.log10(h.evalue) + 200) / 200));
      } else if (colorBy === "taxon") {
        const t = taxonLabel(h);
        point.color = t ? t.label : "unknown";
      }
      return point;
    });
    renderScatter(document.getElementById("scatterMount"), points, {
      xLabel: "% identity", yLabel: "query coverage %",
      colorBy: colorBy !== "none", categorical: colorBy === "taxon",
    });
  }

  function renderTaxonomy() {
    const perQ = perQuerySummary(data, thresholds);
    const bestHits = perQ.map((q) => q.best).filter(Boolean);
    renderTaxonomyChart(document.getElementById("taxMount"), bestHits);
  }

  function renderAllHitsTable() {
    const scope = document.getElementById("allHitsScope").value;
    const hits = scope === "best"
      ? perQuerySummary(data, thresholds).map((q) => q.best).filter(Boolean)
      : filterHits(data.hits, thresholds);
    const cols = EXPORT_COLS.filter((c) => hits.some((h) => h[c] !== undefined));
    allHitsTableHandle = renderHitTable(document.getElementById("allHitsMount"), hits, {
      columns: cols,
      defaultSort: "bitscore",
      onRowClick: (hit) => switchMode("query", hit.qseqid),
    });
  }

  function renderRBH() {
    if (!reverseData) {
      rbhCard.style.display = "none";
      return;
    }
    rbhCard.style.display = "";
    const { pairs, counts } = computeRBH(data, reverseData, thresholds);

    renderCategoryBars(document.getElementById("rbhCounts"), [
      ["Reciprocal", counts.reciprocal],
      ["One-way", counts.oneWay],
      ["No hit", counts.noHit],
    ], {
      colors: { Reciprocal: "var(--moss-500)", "One-way": "var(--amber-500)", "No hit": "var(--warn)" },
    });

    const points = pairs.map((p) => ({
      x: p.fwdBest.pident, y: p.revBest.pident, label: `${p.qseqid} ↔ ${p.partner}`,
    }));
    renderScatter(document.getElementById("rbhScatterMount"), points, {
      xLabel: "forward % identity", yLabel: "reverse % identity",
    });

    const pairMount = document.getElementById("rbhPairMount");
    pairMount.innerHTML = "";
    const wrap = document.createElement("div");
    wrap.className = "table-wrap";
    const table = document.createElement("table");
    table.className = "hit-table";
    table.innerHTML = `<thead><tr>
        <th>query</th><th>partner</th><th>fwd %id</th><th>fwd e-value</th><th>rev %id</th><th>rev e-value</th>
      </tr></thead>`;
    const tbody = document.createElement("tbody");
    for (const p of pairs) {
      const tr = document.createElement("tr");
      const partnerUrl = accessionLinkUrl(p.partner);
      const partnerCell = partnerUrl
        ? `<a href="${partnerUrl}" target="_blank" rel="noopener">${p.partner}</a>`
        : `<span title="Doesn't match a recognised public accession pattern (likely a local/assembly-specific identifier)">${p.partner}</span>`;
      tr.innerHTML = `<td>${p.qseqid}</td><td>${partnerCell}</td>` +
        `<td class="num">${fmtNum(p.fwdBest.pident)}</td><td class="num">${fmtNum(p.fwdBest.evalue)}</td>` +
        `<td class="num">${fmtNum(p.revBest.pident)}</td><td class="num">${fmtNum(p.revBest.evalue)}</td>`;
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    pairMount.appendChild(wrap);

    document.getElementById("rbhExportBtn").onclick = () => {
      const rows = pairs.map((p) => ({
        query: p.qseqid, partner: p.partner,
        fwd_pident: p.fwdBest.pident, fwd_evalue: p.fwdBest.evalue,
        rev_pident: p.revBest.pident, rev_evalue: p.revBest.evalue,
      }));
      const text = toDelimited(rows, ["query", "partner", "fwd_pident", "fwd_evalue", "rev_pident", "rev_evalue"]);
      downloadText("rbh-pairs.tsv", text, "text/tab-separated-values");
    };
  }

  function renderAcrossQueries() {
    renderRunSummary();
    renderPerQueryTable();
    renderAllHitsTable();
    renderCharts();
    renderScatterChart();
    renderTaxonomy();
    renderRBH();
  }

  function renderQuery(qseqid) {
    currentQseqid = qseqid;
    const summary = querySummary(data, qseqid);
    const allHits = data.hits.filter((h) => h.qseqid === qseqid);
    const hits = filterHits(allHits, thresholds).sort((a, b) => {
      if (a.bitscore !== undefined && b.bitscore !== undefined) return b.bitscore - a.bitscore;
      if (a.evalue !== undefined && b.evalue !== undefined) return a.evalue - b.evalue;
      return 0;
    });
    const tiedBest = bestHits(hits);
    const best = tiedBest[0] || (summary && summary.best);

    queryMeta.textContent = summary
      ? `${hits.length} of ${summary.hitCount} hit${summary.hitCount === 1 ? "" : "s"} pass current filters`
      : "";

    const bestHeading = document.getElementById("bestHitHeading");
    const mount = document.getElementById("bestHitMount");
    if (!tiedBest.length) {
      bestHeading.textContent = "Best hit";
      mount.innerHTML = "<dl><dt>—</dt><dd>No hits pass the current filters</dd></dl>";
    } else if (tiedBest.length === 1) {
      bestHeading.textContent = "Best hit";
      mount.innerHTML = `<dl>${bestHitDlRows(best)}</dl>`;
    } else {
      bestHeading.textContent = `Best hit — ${tiedBest.length}-way tie on bit score`;
      mount.innerHTML = tiedBest
        .map((h) => `<div class="tied-best"><b>${h.sseqid}</b><dl>${bestHitDlRows(h)}</dl></div>`)
        .join("");
    }

    const tableMount = document.getElementById("hitTableMount");
    tableHandle = renderHitTable(tableMount, hits);

    renderHitSpan(document.getElementById("hitSpan"), hits, {
      qlen: best && best.qlen,
      onHspClick: (hit) => tableHandle && tableHandle.scrollToHit(hit),
    });
  }

  querySelect.innerHTML = data.queries
    .map((q) => `<option value="${q.qseqid}">${q.qseqid} (${q.hitCount})</option>`)
    .join("");
  querySelect.onchange = () => renderQuery(querySelect.value);

  const undoBtn = document.getElementById("fUndo");

  function applyThresholdsToInputs(t) {
    filterInputs.minPident.value = t.minPident;
    filterInputs.maxEvalue.value = t.maxEvalue === null ? "" : t.maxEvalue;
    filterInputs.minBitscore.value = t.minBitscore;
    filterInputs.minLength.value = t.minLength;
    filterInputs.minQcov.value = t.minQcov;
    filterInputs.excludeSelfHits.checked = t.excludeSelfHits;
    filterInputs.topNPerQuery.value = t.topNPerQuery;
    filterInputs.taxonInclude.value = t.taxonInclude;
    filterInputs.taxonExclude.value = t.taxonExclude;
  }

  function refreshAll() {
    renderAcrossQueries();
    if (querySelect.value) renderQuery(querySelect.value);
  }

  function pushHistory() {
    filterHistory.push(thresholds);
    if (filterHistory.length > 20) filterHistory.shift();
    undoBtn.disabled = false;
  }

  // NOTE: persistent sidebar controls (outside `container`, so they survive a
  // later mountExplorer() call for a new file) use property-style assignment
  // (.oninput=/.onclick=/.onchange=) rather than addEventListener, so that a
  // second file load's fresh handler replaces the first instead of both firing.
  Object.values(filterInputs).forEach((el) => {
    if (!el) return;
    el.oninput = () => {
      pushHistory();
      readThresholds();
      refreshAll();
    };
  });
  resetBtn.onclick = () => {
    pushHistory();
    const d = defaultThresholds();
    applyThresholdsToInputs(d);
    readThresholds();
    refreshAll();
  };
  undoBtn.onclick = () => {
    if (!filterHistory.length) return;
    thresholds = filterHistory.pop();
    applyThresholdsToInputs(thresholds);
    undoBtn.disabled = filterHistory.length === 0;
    refreshAll();
  };
  ["chartMetric", "chartScope"].forEach((id) => { document.getElementById(id).onchange = renderCharts; });
  document.getElementById("scatterColorBy").onchange = renderScatterChart;
  document.getElementById("allHitsScope").onchange = renderAllHitsTable;

  // --- Phase 4: export ---
  function showNote(msg) {
    const err = document.getElementById("err");
    if (!err) return;
    err.textContent = msg;
    err.style.display = "block";
    clearTimeout(showNote._t);
    showNote._t = setTimeout(() => (err.style.display = "none"), 4000);
  }

  function scopeHits() {
    const scope = document.getElementById("exportScope").value;
    const base = scope === "query" && currentQseqid
      ? data.hits.filter((h) => h.qseqid === currentQseqid)
      : data.hits;
    return filterHits(base, thresholds);
  }

  function exportColumnsFor(hits) {
    return EXPORT_COLS.filter((c) => hits.some((h) => h[c] !== undefined));
  }

  const hasSeq = data.meta.hasSequences;
  document.getElementById("exportQseqBtn").style.display = hasSeq ? "" : "none";
  document.getElementById("exportSseqBtn").style.display = hasSeq ? "" : "none";
  document.getElementById("seqExportHint").style.display = hasSeq ? "none" : "";

  document.getElementById("exportTsvBtn").onclick = () => {
    const hits = scopeHits();
    downloadText("blast-hits.tsv", toDelimited(hits, exportColumnsFor(hits), "\t"), "text/tab-separated-values");
  };
  document.getElementById("exportCsvBtn").onclick = () => {
    const hits = scopeHits();
    downloadText("blast-hits.csv", toDelimited(hits, exportColumnsFor(hits), ","), "text/csv");
  };

  document.getElementById("exportQseqBtn").onclick = () => {
    const entries = querySeqEntriesFromHits(scopeHits());
    if (!entries.length) return showNote("No qseq sequences in the current scope.");
    downloadText("query-sequences.fasta", toFasta(entries), "text/x-fasta");
  };
  document.getElementById("exportSseqBtn").onclick = () => {
    const entries = subjectSeqEntriesFromHits(scopeHits());
    if (!entries.length) return showNote("No sseq sequences in the current scope.");
    downloadText("subject-sequences.fasta", toFasta(entries), "text/x-fasta");
  };

  const queryFastaStatus = document.getElementById("queryFastaStatus");
  const exportQueryFastaBtn = document.getElementById("exportQueryFastaBtn");
  const subjectFastaStatus = document.getElementById("subjectFastaStatus");
  const exportSubjectFastaBtn = document.getElementById("exportSubjectFastaBtn");
  const exportCombinedBtn = document.getElementById("exportCombinedBtn");

  exportQueryFastaBtn.onclick = () => {
    if (!queryFastaRecords) return showNote("Upload a query FASTA first.");
    const bucket = document.getElementById("queryFastaBucket").value;
    const perQ = perQuerySummary(data, thresholds);
    const ids = (bucket === "all" ? perQ : perQ.filter((q) => q.flag === bucket)).map((q) => q.qseqid);
    const { entries, unmatched } = matchedFastaEntries(queryFastaRecords, ids);
    if (!entries.length) return showNote("No matching sequences found in the uploaded query FASTA.");
    downloadText(`query-${bucket}.fasta`, toFasta(entries), "text/x-fasta");
    if (unmatched.length) showNote(`${unmatched.length} of ${ids.length} query IDs had no match in the uploaded FASTA.`);
  };

  exportSubjectFastaBtn.onclick = () => {
    if (!subjectFastaRecords) return showNote("Upload a subject FASTA first.");
    const ids = [...new Set(scopeHits().map((h) => h.sseqid))];
    const { entries, unmatched } = matchedFastaEntries(subjectFastaRecords, ids);
    if (!entries.length) return showNote("No matching sequences found in the uploaded subject FASTA.");
    downloadText("subject-subset.fasta", toFasta(entries), "text/x-fasta");
    if (unmatched.length) showNote(`${unmatched.length} of ${ids.length} subject IDs had no match in the uploaded FASTA.`);
  };

  exportCombinedBtn.onclick = () => {
    if (!currentQseqid) return showNote("Select a query first.");
    const queryHits = filterHits(data.hits.filter((h) => h.qseqid === currentQseqid), thresholds);

    let queryEntry = null;
    if (queryFastaRecords) {
      const { entries } = matchedFastaEntries(queryFastaRecords, [currentQseqid]);
      queryEntry = entries[0] || null;
    }
    if (!queryEntry) {
      const [fallback] = querySeqEntriesFromHits(queryHits);
      queryEntry = fallback || null;
    }

    let hitEntries = [];
    const sseqids = [...new Set(queryHits.map((h) => h.sseqid))];
    if (subjectFastaRecords && sseqids.length) {
      hitEntries = matchedFastaEntries(subjectFastaRecords, sseqids).entries;
    }
    if (!hitEntries.length) {
      hitEntries = subjectSeqEntriesFromHits(queryHits);
    }

    const entries = [queryEntry, ...hitEntries].filter(Boolean);
    if (!entries.length) {
      return showNote("No sequences available — upload query/subject FASTA files or use a file with qseq/sseq columns.");
    }
    downloadText(`${currentQseqid}-combined.fasta`, toFasta(entries), "text/x-fasta");
  };

  document.getElementById("exportAccessionBtn").onclick = () => {
    const ids = [...new Set(scopeHits().map((h) => h.sseqid))];
    if (!ids.length) return showNote("No hits in the current scope.");
    downloadText("accessions.txt", accessionListText(ids), "text/plain");
  };

  // --- taxonomy mapping (NCBI names.dmp) ---
  const taxdumpStatus = document.getElementById("taxdumpStatus");
  const taxdumpControls = document.getElementById("taxdumpControls");
  const taxidSourceMode = document.getElementById("taxidSourceMode");
  const taxidPatternRow = document.getElementById("taxidPatternRow");
  const taxidPatternPreset = document.getElementById("taxidPatternPreset");
  const taxidPatternCustom = document.getElementById("taxidPatternCustom");
  const taxdumpPreviewEl = document.getElementById("taxdumpPreview");
  const applyTaxdumpBtn = document.getElementById("applyTaxdumpBtn");
  const clearTaxdumpBtn = document.getElementById("clearTaxdumpBtn");
  const applyBuiltinTaxonomyBtn = document.getElementById("applyBuiltinTaxonomyBtn");

  function currentTaxonPattern() {
    if (taxidPatternPreset.value === "dot") return { type: "delimiter", delimiter: "." };
    if (taxidPatternPreset.value === "dash") return { type: "delimiter", delimiter: "-" };
    return { type: "regex", source: taxidPatternCustom.value.trim() || "^(\\d+)" };
  }
  function currentTaxonSource() {
    return taxidSourceMode.value === "pattern"
      ? { mode: "pattern", pattern: currentTaxonPattern() }
      : { mode: "staxids" };
  }
  function renderTaxdumpPreviewTable() {
    if (!taxonMap) { taxdumpPreviewEl.innerHTML = ""; return; }
    const rows = buildTaxonPreview(data.hits, taxonMap, currentTaxonSource(), 8);
    taxdumpPreviewEl.innerHTML = !rows.length
      ? "<div class=\"empty-note\">No hits to preview.</div>"
      : `<div class="table-wrap"><table class="hit-table"><thead><tr><th>sseqid</th><th>taxon ID</th><th>resolves to</th></tr></thead><tbody>${
        rows.map((r) => `<tr><td>${r.sseqid}</td><td class="num">${r.extractedIds.join(", ") || "—"}</td><td>${r.names.join("; ") || "no match"}</td></tr>`).join("")
      }</tbody></table></div>`;
  }

  taxidSourceMode.onchange = () => {
    taxidPatternRow.style.display = taxidSourceMode.value === "pattern" ? "" : "none";
    renderTaxdumpPreviewTable();
  };
  taxidPatternPreset.onchange = () => {
    taxidPatternCustom.style.display = taxidPatternPreset.value === "custom" ? "" : "none";
    renderTaxdumpPreviewTable();
  };
  taxidPatternCustom.oninput = renderTaxdumpPreviewTable;

  applyTaxdumpBtn.onclick = () => {
    if (!taxonMap) return;
    const { hits: newHits, filledCount } = enrichHitsWithTaxonomy(data.hits, taxonMap, currentTaxonSource());
    data = {
      meta: { ...data.meta, hasTaxonomy: newHits.some((h) => h.staxids || h.sscinames) },
      hits: newHits,
      queries: buildQueries(newHits),
    };
    updateTaxonFilterVisibility();
    renderAcrossQueries();
    if (currentQseqid) renderQuery(currentQseqid);
    taxdumpStatus.textContent = `Loaded ${taxdumpFilename} — filled ${filledCount} hit${filledCount === 1 ? "" : "s"} missing a name.`;
    clearTaxdumpBtn.style.display = "";
  };

  applyBuiltinTaxonomyBtn.onclick = () => {
    if (!taxonomyDb) return;
    const { hits: newHits, filledCount } = enrichHitsWithLineage(data.hits, taxonomyDb);
    data = {
      meta: { ...data.meta, hasTaxonomy: newHits.some((h) => h.staxids || h.sscinames) },
      hits: newHits,
      queries: buildQueries(newHits),
    };
    updateTaxonFilterVisibility();
    renderAcrossQueries();
    if (currentQseqid) renderQuery(currentQseqid);
    taxdumpStatus.textContent = `Built-in taxonomy database — filled ${filledCount} hit${filledCount === 1 ? "" : "s"} missing a name.`;
    clearTaxdumpBtn.style.display = "";
  };

  clearTaxdumpBtn.onclick = () => {
    data = {
      meta: { ...data.meta, hasTaxonomy: pristineHits.some((h) => h.staxids || h.sscinames) },
      hits: pristineHits,
      queries: buildQueries(pristineHits),
    };
    updateTaxonFilterVisibility();
    renderAcrossQueries();
    if (currentQseqid) renderQuery(currentQseqid);
    clearTaxdumpBtn.style.display = "none";
    taxdumpStatus.textContent = taxonMap
      ? `Loaded ${taxdumpFilename} (${taxonMap.size} taxa) — not applied.`
      : "No taxonomy mapping loaded.";
  };

  readThresholds();
  renderAcrossQueries();
  if (data.queries.length) renderQuery(data.queries[0].qseqid);

  return {
    // Returns the fresh handle from the new mountExplorer() call — callers must
    // reassign their reference to it (this instance's own closures/DOM lookups
    // become stale once mountExplorer() rebuilds `container`'s contents).
    setData(newData) {
      return mountExplorer(container, newData);
    },
    setReverseData(newReverseData) {
      reverseData = newReverseData;
      renderRBH();
    },
    setQueryFasta(records, filename) {
      queryFastaRecords = records;
      queryFastaStatus.textContent = records
        ? `Loaded ${filename} (${records.length} sequences)`
        : "No query FASTA loaded.";
      exportQueryFastaBtn.disabled = !records;
    },
    setSubjectFasta(records, filename) {
      subjectFastaRecords = records;
      subjectFastaStatus.textContent = records
        ? `Loaded ${filename} (${records.length} sequences)`
        : "No subject FASTA loaded.";
      exportSubjectFastaBtn.disabled = !records;
    },
    setTaxonMap(map, filename) {
      taxonMap = map;
      taxdumpFilename = filename;
      taxdumpStatus.textContent = `Loaded ${filename} (${map.size} taxa)`;
      taxdumpControls.style.display = "";
      taxidSourceMode.value = data.hits.some((h) => h.staxids) ? "staxids" : "pattern";
      taxidPatternRow.style.display = taxidSourceMode.value === "pattern" ? "" : "none";
      renderTaxdumpPreviewTable();
    },
    setTaxonomyDb(db) {
      taxonomyDb = db;
    },
  };
}
