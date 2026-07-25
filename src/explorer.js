// explorer.js — interactive UI: mountExplorer(container, data).
//
// Phase 1: query selector, ranked hit table, best-hit summary card, hit-span diagram.

import { querySummary, rankedHits, globalSummary } from "./analysis/summary.js";
import { renderHitTable } from "./render/hit-table.js";
import { renderHitSpan } from "./render/hit-span.js";

function fmtNum(v) {
  if (v === undefined || v === null) return "—";
  if (typeof v === "number" && !Number.isInteger(v)) {
    return Math.abs(v) < 0.001 ? v.toExponential(2) : v.toPrecision(4).replace(/\.?0+$/, "");
  }
  return String(v);
}

export function mountExplorer(container, data) {
  const querySelect = document.getElementById("querySelect");
  const queryMeta = document.getElementById("queryMeta");

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

  let tableHandle = null;

  function renderRunSummary() {
    const s = globalSummary(data);
    container.querySelector("#runSummary").innerHTML =
      `<div class="row"><span>Queries</span><b>${s.totalQueries}</b></div>` +
      `<div class="row"><span>Total hits</span><b>${s.totalHits}</b></div>` +
      `<div class="row"><span>Queries with no hit</span><b>${s.queriesWithNoHit}</b></div>`;
  }

  function renderQuery(qseqid) {
    const summary = querySummary(data, qseqid);
    const hits = rankedHits(data, qseqid);
    const best = summary && summary.best;

    queryMeta.textContent = summary ? `${summary.hitCount} hit${summary.hitCount === 1 ? "" : "s"}` : "";

    const dl = container.querySelector("#bestHitDl");
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
      dl.innerHTML = "<dt>—</dt><dd>No hits for this query</dd>";
    }

    const tableMount = container.querySelector("#hitTableMount");
    tableHandle = renderHitTable(tableMount, hits);

    renderHitSpan(container.querySelector("#hitSpan"), hits, {
      qlen: best && best.qlen,
      onHspClick: (hit) => tableHandle && tableHandle.scrollToHit(hit),
    });
  }

  querySelect.innerHTML = data.queries
    .map((q) => `<option value="${q.qseqid}">${q.qseqid} (${q.hitCount})</option>`)
    .join("");
  querySelect.onchange = () => renderQuery(querySelect.value);

  renderRunSummary();
  if (data.queries.length) renderQuery(data.queries[0].qseqid);

  return {
    setData(newData) {
      data = newData;
      mountExplorer(container, newData);
    },
  };
}
