# Clann BLAST Explorer

A free, browser-only tool for exploring BLAST tabular output (`-outfmt 6`/`7`) and
DIAMOND tabular output. Companion to [Clann Tree Viewer](https://github.com/ChrisCreevey/clann-tree-viewer).

Load your BLAST results and see, per query, a ranked hit table, a best-hit
summary, and a coverage diagram of where each HSP falls along the query.
Across the whole run: filter, summarise, fill in missing taxonomy, compute
reciprocal best hits, and export FASTA subsets or CSV/TSV for downstream
alignment and phylogenetic analyses.

**Nothing is uploaded.** Everything runs client-side, in your browser.

Live at **[chriscreevey.github.io/clann-blast-explorer](https://chriscreevey.github.io/clann-blast-explorer/)**.

## Loading data

Click "Open file…", drag a file onto the window, or paste tabular text
directly. Accepted inputs:

- `-outfmt 6` (headerless, or with a plain header row)
- `-outfmt 7` (with a `# Fields:` line)
- DIAMOND's default tabular output (same 12-column layout as `-outfmt 6`)
- Any of the above as `.gz` or `.zip` — decompressed in your browser before
  parsing, detected by file content rather than extension

If a file has no header of any kind, headerless data is **never** silently
assigned the standard column order, even when it happens to have exactly 12
columns — a custom `-outfmt "6 ..."` spec could easily have a different order
at the same count. Instead a manual column-mapping step opens: a preview of
the first few rows with a dropdown per column, prefilled with a best guess
you confirm or correct.

## Two ways to look at your data

- **Per-query view** — pick a query from the sidebar dropdown to see its best
  hit (or every hit tied for the top bit score, shown separately rather than
  picking one arbitrarily), an HSP coverage diagram (click a segment to jump
  to its row in the hit table), and the full sortable hit table for that query.
- **All-queries view** — switch to this at the top of the main panel for a
  whole-run perspective: a run summary, a per-query summary table, a flat "All
  hits" table spanning every query at once, distribution charts, an
  identity-vs-coverage scatter, a taxonomy breakdown, and RBH mode's results.
  Clicking a row in either summary table jumps into that query's Per-query view.

## Sidebar sections

- **Filters** — thresholds for %identity, e-value, bit score, alignment
  length, and query coverage; self-hit exclusion; a top-N-per-query cap; and
  taxon include/exclude once taxonomy information is available. Applies live
  everywhere at once, with Undo and Reset.
- **Taxonomy mapping** — if your run has `staxids` but no scientific names
  (common without NCBI's taxdb installed locally), upload `names.dmp` or the
  full `taxdump.tar.gz`/`new_taxdump.tar.gz` (gunzipped and untarred entirely
  client-side) to back them in. The taxon ID source is configurable: the
  `staxids` column, or extracted from `sseqid` itself for ID schemes like
  STRING/EggNOG's `9606.ENSP00000269305` (a genuine taxon ID as a prefix) — a
  preview always shows what will resolve before you apply it, since a
  pattern-extracted ID can coincidentally match an unrelated real taxon
  without looking wrong. Feeds the taxonomy chart, taxon filters, and hit
  table automatically; "Clear mapping" reverts to the originally parsed data.
- **RBH mode** — load a second (reverse) BLAST/DIAMOND run to compute
  reciprocal best hits against the current (forward) run. Classifies each
  query as reciprocal / one-way / no hit under the active filters, with a
  count breakdown, a forward-vs-reverse %identity scatter, and an exportable
  pair table.
- **Export** — pick a scope (current query, or all hits passing filters),
  then: TSV/CSV of the hit table; FASTA directly from `qseq`/`sseq` columns
  when present; upload the original query/subject FASTA for ID-matched export
  of a subset (passing filters, weak-hit, no-hit, or all); a combined
  query+hits FASTA ready for an alignment tool; or a plain accession list for
  NCBI Batch Entrez when sequences aren't available locally.

## What it does not do

- Does not run BLAST or DIAMOND searches
- Does not fetch sequences (or taxonomy dumps) from NCBI/UniProt/EBI
  automatically — links out only; you download and upload yourself
- Does not build alignments or trees (stages data for tools that do, including
  [Clann Tree Viewer](https://github.com/ChrisCreevey/clann-tree-viewer))
- Does not upload any data anywhere

## Running locally

No build step — plain ES modules.

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000`.

## Testing

```bash
node --test
```

## Status

Built in phases (see `clann-blast-explorer-BUILD-BRIEF.md`), then extended
beyond the original brief:

- [x] **Phase 1** — load, parse, per-query view (hit table, best-hit card, HSP coverage diagram)
- [x] **Phase 2** — across-queries summary, filtering, distribution charts, taxonomy chart
- [x] **Phase 3** — RBH mode
- [x] **Phase 4** — FASTA integration and export
- [x] **Phase 5** — polish and parity with the tree viewer
- [x] Manual column-mapping UI for headerless data auto-detection can't handle
- [x] All-queries mode as a first-class view, separate from per-query
- [x] NCBI taxonomy dump support (`names.dmp`/`taxdump.tar.gz`, two taxon ID sources)
- [x] Gzip/zip support on every file upload

## Outstanding placeholders (see build brief §9)

- **§9a.** Additional teaching-derived analyses (contamination screening, identity/coverage
  rules of thumb, extra figure types) — marked `TODO` in `src/analysis/summary.js`.
- **§9b.** `examples/` currently contains only synthetic, clearly-labelled placeholder data;
  swap in real BLAST output once supplied.
- **§9c.** NCBI web BLAST "Hit Table" download format (a fourth input variant) is not yet
  implemented — needs a real exported file to confirm its column layout.

## Licence

GPL-2.0, matching the sibling [clann-tree-viewer](https://github.com/ChrisCreevey/clann-tree-viewer) repository.
