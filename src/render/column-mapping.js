// column-mapping.js — manual column-mapping UI, shown when format auto-detection
// fails (no "# Fields:" line, no recognisable plain header, headerless data
// that doesn't look like the standard 12 columns). Lets the user assign each
// column by hand from a preview of the first few rows, then re-parse.

import { KNOWN_FIELDS, guessColumns } from "../parse/blast-tabular.js";

const FIELD_LABELS = {
  qseqid: "qseqid — query ID", sseqid: "sseqid — subject ID", pident: "pident — % identity",
  length: "length — alignment length", mismatch: "mismatch", gapopen: "gapopen",
  qstart: "qstart", qend: "qend", sstart: "sstart", send: "send",
  evalue: "evalue", bitscore: "bitscore",
  qlen: "qlen — query length", slen: "slen — subject length",
  staxids: "staxids — taxon IDs", sscinames: "sscinames — scientific names",
  scomnames: "scomnames — common names", sskingdoms: "sskingdoms — kingdoms",
  qcovs: "qcovs — query coverage %", qcovhsp: "qcovhsp — query coverage % (per HSP)",
  stitle: "stitle — subject title", qseq: "qseq — query sequence", sseq: "sseq — subject sequence",
};

/**
 * Render the mapping UI into `container`.
 * opts: { message, previewRows, onApply(columns), onCancel() }
 */
export function renderColumnMapping(container, opts) {
  const { message, previewRows, onApply, onCancel } = opts;
  container.innerHTML = "";
  const colCount = previewRows[0] ? previewRows[0].length : 0;
  const guesses = guessColumns(colCount);

  const wrap = document.createElement("div");
  wrap.className = "column-mapping";

  const heading = document.createElement("h2");
  heading.textContent = "Manual column mapping";
  wrap.appendChild(heading);

  const msg = document.createElement("p");
  msg.className = "hint";
  msg.textContent = `${message} Assign each column below using the preview data, then load.`;
  wrap.appendChild(msg);

  const tableWrap = document.createElement("div");
  tableWrap.className = "table-wrap";
  const table = document.createElement("table");
  table.className = "hit-table column-mapping-table";

  const selects = [];
  const thead = document.createElement("thead");
  const trh = document.createElement("tr");
  for (let i = 0; i < colCount; i++) {
    const th = document.createElement("th");
    const select = document.createElement("select");
    const skipOpt = document.createElement("option");
    skipOpt.value = "";
    skipOpt.textContent = "(skip this column)";
    select.appendChild(skipOpt);
    for (const f of KNOWN_FIELDS) {
      const opt = document.createElement("option");
      opt.value = f;
      opt.textContent = FIELD_LABELS[f] || f;
      select.appendChild(opt);
    }
    select.value = guesses[i] || "";
    selects.push(select);
    th.appendChild(select);
    trh.appendChild(th);
  }
  thead.appendChild(trh);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (const row of previewRows) {
    const tr = document.createElement("tr");
    for (let i = 0; i < colCount; i++) {
      const td = document.createElement("td");
      td.textContent = row[i] ?? "";
      td.title = row[i] ?? "";
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  tableWrap.appendChild(table);
  wrap.appendChild(tableWrap);

  const actions = document.createElement("div");
  actions.className = "column-mapping-actions";
  const applyBtn = document.createElement("button");
  applyBtn.className = "act";
  applyBtn.textContent = "Load with this mapping";
  applyBtn.addEventListener("click", () => onApply(selects.map((s) => s.value)));
  const cancelBtn = document.createElement("button");
  cancelBtn.className = "act warn";
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", onCancel);
  actions.appendChild(applyBtn);
  actions.appendChild(cancelBtn);
  wrap.appendChild(actions);

  container.appendChild(wrap);
}
