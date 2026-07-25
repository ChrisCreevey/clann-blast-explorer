// hit-table.js — sortable hit table for a single query's ranked hits.

import { accessionLinkUrl } from "../parse/accession.js";

const NUMERIC = new Set([
  "pident", "length", "mismatch", "gapopen", "qstart", "qend", "sstart", "send",
  "evalue", "bitscore", "qlen", "slen", "qcovs", "qcovhsp",
]);

export const DEFAULT_COLS = ["sseqid", "sscinames", "pident", "length", "mismatch", "gapopen", "qstart", "qend", "sstart", "send", "evalue", "bitscore"];

/** Stable identity for a hit row, independent of sort order — used to link the HSP diagram back to its table row. */
export function hitKey(hit) {
  return [hit.sseqid, hit.qstart, hit.qend, hit.sstart, hit.send].join("|");
}

function fmt(v) {
  if (v === undefined || v === null) return "";
  if (typeof v === "number") {
    if (Number.isInteger(v)) return String(v);
    return Math.abs(v) < 0.001 || Math.abs(v) >= 1e6 ? v.toExponential(2) : v.toPrecision(4).replace(/\.?0+$/, "");
  }
  if (Array.isArray(v)) return v.join(", ");
  return String(v);
}

/**
 * Render a sortable hit table into `container` for the given hits.
 * Returns a handle with setHits(hits) to update in place.
 */
export function renderHitTable(container, hits, opts = {}) {
  const cols = opts.columns || DEFAULT_COLS.filter((c) => hits.some((h) => h[c] !== undefined));
  let sortCol = opts.defaultSort || "bitscore";
  let sortAsc = false;
  let currentHits = hits;

  const wrap = document.createElement("div");
  wrap.className = "table-wrap";
  const table = document.createElement("table");
  table.className = "hit-table";
  wrap.appendChild(table);

  function draw() {
    const sorted = currentHits.slice().sort((a, b) => {
      const av = a[sortCol], bv = b[sortCol];
      if (av === undefined && bv === undefined) return 0;
      if (av === undefined) return 1;
      if (bv === undefined) return -1;
      const cmp = av < bv ? -1 : av > bv ? 1 : 0;
      return sortAsc ? cmp : -cmp;
    });

    table.innerHTML = "";
    const thead = document.createElement("thead");
    const trh = document.createElement("tr");
    for (const col of cols) {
      const th = document.createElement("th");
      th.textContent = col;
      if (col === sortCol) th.className = "sorted" + (sortAsc ? " asc" : "");
      th.addEventListener("click", () => {
        if (sortCol === col) sortAsc = !sortAsc;
        else { sortCol = col; sortAsc = false; }
        draw();
      });
      trh.appendChild(th);
    }
    thead.appendChild(trh);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    for (const hit of sorted) {
      const tr = document.createElement("tr");
      tr.dataset.key = hitKey(hit);
      if (opts.onRowClick) {
        tr.classList.add("row-clickable");
        tr.addEventListener("click", () => opts.onRowClick(hit));
      }
      for (const col of cols) {
        const td = document.createElement("td");
        if (NUMERIC.has(col)) td.className = "num";
        if (col === "sseqid") {
          const url = accessionLinkUrl(hit.sseqid);
          if (url) {
            const a = document.createElement("a");
            a.href = url;
            a.target = "_blank";
            a.rel = "noopener";
            a.textContent = fmt(hit.sseqid);
            td.appendChild(a);
          } else {
            td.textContent = fmt(hit.sseqid);
            td.title = "Doesn't match a recognised public accession pattern (likely a local/assembly-specific identifier)";
          }
        } else {
          td.textContent = fmt(hit[col]);
        }
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
  }

  draw();
  container.innerHTML = "";
  container.appendChild(wrap);

  return {
    setHits(newHits) { currentHits = newHits; draw(); },
    /** Scroll the row for `hit` into view and briefly highlight it. */
    scrollToHit(hit) {
      const tr = table.querySelector(`tr[data-key="${CSS.escape(hitKey(hit))}"]`);
      if (!tr) return;
      tr.scrollIntoView({ block: "center", behavior: "smooth" });
      tr.classList.remove("flash");
      // eslint-disable-next-line no-unused-expressions
      tr.offsetWidth; // restart the animation if already flashing
      tr.classList.add("flash");
      setTimeout(() => tr.classList.remove("flash"), 1500);
    },
  };
}
