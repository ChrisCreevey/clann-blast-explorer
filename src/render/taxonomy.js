// taxonomy.js — taxonomy bar chart, hand-written SVG (no charting library).
// Uses staxids/sscinames when present; falls back to a genus/species heuristic
// parsed from stitle when absent (labelled as approximate).

const SVG_NS = "http://www.w3.org/2000/svg";

function el(tag, attrs) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

const STITLE_BRACKET_RE = /\[([A-Z][a-z]+(?:\s[a-z]+)?)\]/;

/** Best-effort taxon label for a hit: { label, approximate } or null if none available. */
export function taxonLabel(hit) {
  if (hit.sscinames) {
    const first = String(hit.sscinames).split(";")[0].trim();
    if (first) return { label: first, approximate: false };
  }
  if (hit.stitle) {
    const m = STITLE_BRACKET_RE.exec(hit.stitle);
    if (m) return { label: m[1], approximate: true };
  }
  return null;
}

/**
 * Render a horizontal bar chart of taxon counts across `hits` (typically
 * best-hit-per-query). Shows a "(approximate, parsed from hit titles)" note
 * when falling back to the stitle heuristic.
 */
export function renderTaxonomyChart(container, hits, opts = {}) {
  container.innerHTML = "";
  const counts = new Map();
  let anyApprox = false;
  let anyLabel = false;
  for (const h of hits) {
    const t = taxonLabel(h);
    if (!t) continue;
    anyLabel = true;
    if (t.approximate) anyApprox = true;
    counts.set(t.label, (counts.get(t.label) || 0) + 1);
  }

  if (!anyLabel) {
    const note = document.createElement("div");
    note.className = "empty-note";
    note.textContent = "No taxonomy information available (no staxids/sscinames, and no parseable species name in stitle).";
    container.appendChild(note);
    return;
  }

  const entries = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const top = entries.slice(0, 12);
  const otherCount = entries.slice(12).reduce((s, [, c]) => s + c, 0);
  if (otherCount > 0) top.push(["Other", otherCount]);

  const width = 460, rowH = 20, pad = 8, labelW = 150;
  const height = pad * 2 + top.length * rowH;
  const maxCount = Math.max(...top.map(([, c]) => c));
  const barAreaW = width - labelW - pad * 2;

  const svg = el("svg", { viewBox: `0 0 ${width} ${height}`, class: "chart-svg taxonomy-svg" });
  top.forEach(([label, count], i) => {
    const y = pad + i * rowH;
    const barW = maxCount ? (count / maxCount) * barAreaW : 0;
    const text = el("text", { class: "tax-label", x: labelW - 6, y: y + rowH / 2 + 4, "text-anchor": "end" });
    text.textContent = label;
    svg.appendChild(text);
    svg.appendChild(el("rect", {
      class: "tax-bar", x: labelW, y: y + 3, width: Math.max(1, barW), height: rowH - 6, rx: 2,
    }));
    const countText = el("text", { class: "tax-count", x: labelW + barW + 6, y: y + rowH / 2 + 4 });
    countText.textContent = String(count);
    svg.appendChild(countText);
  });

  container.appendChild(svg);

  if (anyApprox) {
    const note = document.createElement("div");
    note.className = "hint";
    note.textContent = "Some labels are approximate — parsed from hit titles, not staxids/sscinames.";
    container.appendChild(note);
  }
}
