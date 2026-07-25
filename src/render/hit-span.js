// hit-span.js — per-query HSP coverage diagram: query as a bar, HSPs as coloured
// segments along it, showing coverage and overlap. Hand-written SVG, no charting library.

const SVG_NS = "http://www.w3.org/2000/svg";

function el(tag, attrs) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

/**
 * Render a hit-span diagram into `container` for one query's ranked hits.
 * Falls back to a "no length info" note when qlen/qstart/qend aren't usable.
 */
export function renderHitSpan(container, hits, opts = {}) {
  container.innerHTML = "";
  if (!hits.length) {
    const note = document.createElement("div");
    note.className = "empty-note";
    note.textContent = "No hits to show.";
    container.appendChild(note);
    return;
  }

  const qlen = opts.qlen || Math.max(...hits.map((h) => Math.max(h.qstart || 0, h.qend || 0)));
  if (!qlen) {
    const note = document.createElement("div");
    note.className = "empty-note";
    note.textContent = "No query length/position info available for a coverage diagram.";
    container.appendChild(note);
    return;
  }

  const width = 640, rowH = 16, pad = 30;
  const height = pad + hits.length * rowH + pad;
  const svg = el("svg", { viewBox: `0 0 ${width} ${height}`, class: "hit-span-svg" });

  const scale = (pos) => pad + (pos / qlen) * (width - 2 * pad);

  svg.appendChild(el("line", {
    class: "axis", x1: pad, x2: width - pad, y1: pad - 6, y2: pad - 6,
  }));
  svg.appendChild(el("rect", {
    class: "qbar", x: pad, y: pad - 10, width: width - 2 * pad, height: 4, rx: 2,
  }));

  const defs = el("defs", {});
  svg.appendChild(defs);

  hits.forEach((h, i) => {
    const y = pad + i * rowH;
    const x1 = scale(Math.min(h.qstart || 0, h.qend || 0));
    const x2 = scale(Math.max(h.qstart || 0, h.qend || 0));
    const boxW = Math.max(1, x2 - x1);
    const boxH = rowH - 4;
    const g = el("g", {});
    const rect = el("rect", {
      class: "hsp", x: x1, y, width: boxW, height: boxH, rx: 2,
    });
    const title = el("title", {});
    title.textContent = `${h.sseqid}  ${h.qstart}-${h.qend}  ${h.pident ?? "?"}% id  e=${h.evalue ?? "?"}`;
    rect.appendChild(title);
    if (opts.onHspClick) {
      rect.classList.add("clickable");
      g.addEventListener("click", () => opts.onHspClick(h));
      g.classList.add("clickable");
    }
    g.appendChild(rect);

    if (h.sseqid && boxW >= 14) {
      const clipId = `hsp-clip-${i}`;
      const clip = el("clipPath", { id: clipId });
      clip.appendChild(el("rect", { x: x1, y, width: boxW, height: boxH }));
      defs.appendChild(clip);

      const label = el("text", {
        class: "hsp-label", x: x1 + boxW / 2, y: y + boxH - 3, "text-anchor": "middle",
        "clip-path": `url(#${clipId})`,
      });
      label.textContent = h.sseqid;
      g.appendChild(label);
    }

    svg.appendChild(g);
  });

  const startLabel = el("text", { x: pad, y: height - 8 });
  startLabel.textContent = "1";
  svg.appendChild(startLabel);
  const endLabel = el("text", { x: width - pad, y: height - 8, "text-anchor": "end" });
  endLabel.textContent = String(qlen);
  svg.appendChild(endLabel);

  container.appendChild(svg);
}
