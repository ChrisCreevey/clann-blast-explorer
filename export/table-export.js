// table-export.js — CSV/TSV export of tabular rows.
// Full filtered-hit-table export arrives in Phase 4; the RBH pair table (Phase 3) uses this too.

function escapeCell(value, delimiter) {
  const s = value === undefined || value === null ? "" : String(value);
  if (s.includes(delimiter) || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** Build delimited text (default tab) from row objects and an ordered list of column keys. */
export function toDelimited(rows, columns, delimiter = "\t") {
  const lines = [columns.join(delimiter)];
  for (const row of rows) {
    lines.push(columns.map((c) => escapeCell(row[c], delimiter)).join(delimiter));
  }
  return lines.join("\n") + "\n";
}

/** Trigger a browser download of `text` as `filename`. */
export function downloadText(filename, text, mimeType = "text/plain") {
  const blob = new Blob([text], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
