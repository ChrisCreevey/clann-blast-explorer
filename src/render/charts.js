// charts.js — histograms and scatter plots, hand-written SVG (no charting library).

const SVG_NS = "http://www.w3.org/2000/svg";

function el(tag, attrs) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

function emptyNote(container, text) {
  container.innerHTML = "";
  const note = document.createElement("div");
  note.className = "empty-note";
  note.textContent = text;
  container.appendChild(note);
}

/**
 * Render a histogram of `values` (numbers, undefined/NaN dropped) into `container`.
 * opts.log10: bin on a log10 scale (used for e-value).
 */
export function renderHistogram(container, values, opts = {}) {
  const clean = values.filter((v) => typeof v === "number" && !Number.isNaN(v) && (!opts.log10 || v > 0));
  if (!clean.length) return emptyNote(container, "No data for this metric.");

  const xs = opts.log10 ? clean.map((v) => Math.log10(v)) : clean;
  const min = Math.min(...xs), max = Math.max(...xs);
  const width = 460, height = 160, pad = 30;
  const binCount = 20;
  const span = max - min || 1;
  const bins = new Array(binCount).fill(0);
  for (const x of xs) {
    const idx = Math.min(binCount - 1, Math.floor(((x - min) / span) * binCount));
    bins[idx]++;
  }
  const maxCount = Math.max(...bins);

  const svg = el("svg", { viewBox: `0 0 ${width} ${height}`, class: "chart-svg" });
  const barW = (width - 2 * pad) / binCount;
  bins.forEach((count, i) => {
    const barH = maxCount ? (count / maxCount) * (height - 2 * pad) : 0;
    svg.appendChild(el("rect", {
      class: "hist-bar",
      x: pad + i * barW,
      y: height - pad - barH,
      width: Math.max(1, barW - 1),
      height: barH,
    }));
  });
  svg.appendChild(el("line", { class: "axis", x1: pad, x2: width - pad, y1: height - pad, y2: height - pad }));

  const fmtTick = (v) => (opts.log10 ? `1e${v.toFixed(0)}` : v.toPrecision(3).replace(/\.?0+$/, ""));
  const minLabel = el("text", { x: pad, y: height - 10 });
  minLabel.textContent = fmtTick(min);
  svg.appendChild(minLabel);
  const maxLabel = el("text", { x: width - pad, y: height - 10, "text-anchor": "end" });
  maxLabel.textContent = fmtTick(max);
  svg.appendChild(maxLabel);

  container.innerHTML = "";
  container.appendChild(svg);
}

/**
 * Render a scatter plot of {x, y, color?} points into `container`.
 * opts.colorScale: array of category strings for a discrete legend (from opts.colorKey values).
 */
export function renderScatter(container, points, opts = {}) {
  const clean = points.filter((p) => typeof p.x === "number" && typeof p.y === "number" && !Number.isNaN(p.x) && !Number.isNaN(p.y));
  if (!clean.length) return emptyNote(container, "No data for this plot.");

  const width = 460, height = 260, pad = 34;
  const xMin = 0, xMax = Math.max(100, ...clean.map((p) => p.x));
  const yMin = 0, yMax = Math.max(100, ...clean.map((p) => p.y));
  const sx = (x) => pad + ((x - xMin) / (xMax - xMin || 1)) * (width - 2 * pad);
  const sy = (y) => height - pad - ((y - yMin) / (yMax - yMin || 1)) * (height - 2 * pad);

  const categories = opts.categorical ? [...new Set(clean.map((p) => p.color))].sort() : null;
  const colorOf = (p) => {
    if (!opts.colorBy) return null;
    if (categories) {
      const idx = categories.indexOf(p.color);
      return `hsl(${(idx * 47) % 360} 55% 45%)`;
    }
    // continuous (e.g. -log10 evalue): map to a teal ramp
    const t = Math.max(0, Math.min(1, p.color));
    return `color-mix(in srgb, var(--accent) ${Math.round(t * 100)}%, var(--line))`;
  };

  const svg = el("svg", { viewBox: `0 0 ${width} ${height}`, class: "chart-svg" });
  svg.appendChild(el("line", { class: "axis", x1: pad, x2: width - pad, y1: height - pad, y2: height - pad }));
  svg.appendChild(el("line", { class: "axis", x1: pad, x2: pad, y1: pad, y2: height - pad }));

  for (const p of clean) {
    const circle = el("circle", {
      class: "scatter-pt", cx: sx(p.x), cy: sy(p.y), r: 3,
      ...(colorOf(p) ? { fill: colorOf(p) } : {}),
    });
    const title = el("title", {});
    title.textContent = p.label || `${p.x.toFixed(1)}, ${p.y.toFixed(1)}`;
    circle.appendChild(title);
    svg.appendChild(circle);
  }

  const xLabel = el("text", { x: width / 2, y: height - 6, "text-anchor": "middle" });
  xLabel.textContent = opts.xLabel || "";
  svg.appendChild(xLabel);
  const yLabel = el("text", { x: 8, y: height / 2, "text-anchor": "middle", transform: `rotate(-90 8 ${height / 2})` });
  yLabel.textContent = opts.yLabel || "";
  svg.appendChild(yLabel);

  container.innerHTML = "";
  container.appendChild(svg);

  if (categories && categories.length) {
    const legend = document.createElement("div");
    legend.className = "chart-legend";
    legend.innerHTML = categories
      .map((c, i) => `<span class="sw" style="background:hsl(${(i * 47) % 360} 55% 45%)"></span>${c}`)
      .join(" &nbsp; ");
    container.appendChild(legend);
  }
}
