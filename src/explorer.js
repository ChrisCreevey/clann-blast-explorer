// explorer.js — interactive UI: mountExplorer(container, data).
//
// Phase 1: query selector, ranked hit table, best-hit summary card, hit-span diagram.
// Phase 2: filters (sidebar), per-query summary table, distribution charts,
// identity-vs-coverage scatter, taxonomy chart — all live against the active thresholds.

import { querySummary, globalSummary, perQuerySummary } from "./analysis/summary.js";
import { defaultThresholds, filterHits, computeQcov } from "./analysis/filters.js";
import { renderHitTable } from "./render/hit-table.js";
import { renderHitSpan } from "./render/hit-span.js";
import { renderHistogram, renderScatter } from "./render/charts.js";
import { renderTaxonomyChart, taxonLabel } from "./render/taxonomy.js";

function fmtNum(v) {
  if (v === undefined || v === null) return "—";
  if (typeof v === "number" && !Number.isInteger(v)) {
    return Math.abs(v) < 0.001 ? v.toExponential(2) : v.toPrecision(4).replace(/\.?0+$/, "");
  }
  return String(v);
}

const FLAG_LABEL = { hit: "hit", weak: "weak", none: "no hit" };

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
  const rowTaxonInclude = document.getElementById("rowTaxonInclude");
  const rowTaxonExclude = document.getElementById("rowTaxonExclude");
  const taxonIncludeInput = filterInputs.taxonInclude;
  const taxonExcludeInput = filterInputs.taxonExclude;

  const showTaxonFilters = !!data.meta.hasTaxonomy;
  [rowTaxonInclude, rowTaxonExclude, taxonIncludeInput, taxonExcludeInput].forEach((el) => {
    if (el) el.style.display = showTaxonFilters ? "" : "none";
  });

  let thresholds = defaultThresholds();

  container.innerHTML = "";
  const summaryCard = document.createElement("div");
  summaryCard.className = "card";
  summaryCard.innerHTML = "<h3>Run summary</h3><div id=\"runSummary\"></div>";
  container.appendChild(summaryCard);

  const bestHitCard = document.createElement("div");
  bestHitCard.className = "card best-hit-card";
  bestHitCard.innerHTML = "<h3>Best hit</h3><dl id=\"bestHitDl\"></dl>";
  container.appendChild(bestHitCard);

  const spanCard = document.createElement("div");
  spanCard.className = "card";
  spanCard.innerHTML = "<h3>HSP coverage</h3><div id=\"hitSpan\"></div>";
  container.appendChild(spanCard);

  const tableCard = document.createElement("div");
  tableCard.className = "card";
  tableCard.innerHTML = "<h3>Hits for this query</h3><div id=\"hitTableMount\"></div>";
  container.appendChild(tableCard);

  const perQueryCard = document.createElement("div");
  perQueryCard.className = "card";
  perQueryCard.innerHTML = "<h3>Per-query summary (all queries)</h3><div id=\"perQueryMount\"></div>";
  container.appendChild(perQueryCard);

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
  container.appendChild(chartsCard);

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
  container.appendChild(scatterCard);

  const taxCard = document.createElement("div");
  taxCard.className = "card";
  taxCard.innerHTML = "<h3>Taxonomy (best hit per query)</h3><div id=\"taxMount\"></div>";
  container.appendChild(taxCard);

  let tableHandle = null;

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
      tr.innerHTML = `<td>${r.qseqid}</td><td class="num">${r.hitCount}</td><td class="num">${r.passingCount}</td>` +
        `<td>${r.best ? r.best.sseqid : "—"}</td>` +
        `<td class="num">${r.best ? fmtNum(r.best.pident) : "—"}</td>` +
        `<td class="num">${r.best ? fmtNum(r.best.evalue) : "—"}</td>` +
        `<td><span class="flag-badge flag-${r.flag}">${FLAG_LABEL[r.flag]}</span></td>`;
      tr.addEventListener("click", () => {
        querySelect.value = r.qseqid;
        renderQuery(r.qseqid);
      });
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

  function renderAcrossQueries() {
    renderRunSummary();
    renderPerQueryTable();
    renderCharts();
    renderScatterChart();
    renderTaxonomy();
  }

  function renderQuery(qseqid) {
    const summary = querySummary(data, qseqid);
    const allHits = data.hits.filter((h) => h.qseqid === qseqid);
    const hits = filterHits(allHits, thresholds).sort((a, b) => {
      if (a.bitscore !== undefined && b.bitscore !== undefined) return b.bitscore - a.bitscore;
      if (a.evalue !== undefined && b.evalue !== undefined) return a.evalue - b.evalue;
      return 0;
    });
    const best = hits[0] || (summary && summary.best);

    queryMeta.textContent = summary
      ? `${hits.length} of ${summary.hitCount} hit${summary.hitCount === 1 ? "" : "s"} pass current filters`
      : "";

    const dl = document.getElementById("bestHitDl");
    if (best) {
      dl.innerHTML = [
        ["Subject", best.sseqid],
        ["% identity", fmtNum(best.pident)],
        ["Alignment length", fmtNum(best.length)],
        ["E-value", fmtNum(best.evalue)],
        ["Bit score", fmtNum(best.bitscore)],
        best.stitle ? ["Title", best.stitle] : null,
      ].filter(Boolean).map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("");
    } else {
      dl.innerHTML = "<dt>—</dt><dd>No hits pass the current filters</dd>";
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

  Object.values(filterInputs).forEach((el) => {
    if (!el) return;
    el.addEventListener("input", () => {
      readThresholds();
      renderAcrossQueries();
      if (querySelect.value) renderQuery(querySelect.value);
    });
  });
  resetBtn.addEventListener("click", () => {
    const d = defaultThresholds();
    filterInputs.minPident.value = d.minPident;
    filterInputs.maxEvalue.value = "";
    filterInputs.minBitscore.value = d.minBitscore;
    filterInputs.minLength.value = d.minLength;
    filterInputs.minQcov.value = d.minQcov;
    filterInputs.excludeSelfHits.checked = d.excludeSelfHits;
    filterInputs.topNPerQuery.value = d.topNPerQuery;
    filterInputs.taxonInclude.value = "";
    filterInputs.taxonExclude.value = "";
    readThresholds();
    renderAcrossQueries();
    if (querySelect.value) renderQuery(querySelect.value);
  });
  ["chartMetric", "chartScope"].forEach((id) => document.getElementById(id).addEventListener("change", renderCharts));
  document.getElementById("scatterColorBy").addEventListener("change", renderScatterChart);

  readThresholds();
  renderAcrossQueries();
  if (data.queries.length) renderQuery(data.queries[0].qseqid);

  return {
    setData(newData) {
      data = newData;
      mountExplorer(container, newData);
    },
  };
}
