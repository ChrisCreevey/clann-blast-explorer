# Clann BLAST Explorer

A free, browser-only tool for exploring BLAST tabular output (`-outfmt 6`/`7`) and
DIAMOND tabular output. Companion to [Clann Tree Viewer](https://github.com/ChrisCreevey/clann-tree-viewer).

Load your BLAST results and see, per query, a ranked hit table, a best-hit
summary, and a coverage diagram of where each HSP falls along the query.
Across the whole run: filter, summarise, compute reciprocal best hits, and
export FASTA subsets or CSV/TSV for downstream alignment and phylogenetic analyses.

**Nothing is uploaded.** Everything runs client-side, in your browser.

## What it does not do

- Does not run BLAST or DIAMOND searches
- Does not fetch sequences from NCBI/UniProt/EBI automatically (links out only)
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

Building in phases (see `clann-blast-explorer-BUILD-BRIEF.md`):

- [x] **Phase 1** — load, parse, per-query view (hit table, best-hit card, HSP coverage diagram)
- [x] **Phase 2** — across-queries summary, filtering, distribution charts, taxonomy chart
- [x] **Phase 3** — RBH mode
- [x] **Phase 4** — FASTA integration and export
- [ ] **Phase 5** — polish and parity with the tree viewer

## Outstanding placeholders (see build brief §9)

- **§9a.** Additional teaching-derived analyses (contamination screening, identity/coverage
  rules of thumb, extra figure types) — marked `TODO` in `src/analysis/summary.js`.
- **§9b.** `examples/` currently contains only synthetic, clearly-labelled placeholder data;
  swap in real BLAST output once supplied.
- **§9c.** NCBI web BLAST "Hit Table" download format (a fourth input variant) is not yet
  implemented — needs a real exported file to confirm its column layout.

## Licence

GPL-2.0, matching the sibling [clann-tree-viewer](https://github.com/ChrisCreevey/clann-tree-viewer) repository.
