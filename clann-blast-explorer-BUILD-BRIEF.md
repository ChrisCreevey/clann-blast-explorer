# Clann BLAST Explorer — Build Brief for Claude Code

This document specifies a standalone, browser-only web app for exploring BLAST tabular output, to be hosted on GitHub Pages as a companion to [Clann Tree Viewer](https://github.com/ChrisCreevey/clann-tree-viewer). It follows that project's conventions directly. Read this brief in full before starting, and treat the existing `clann-tree-viewer` repository as the reference implementation for style, structure, and tone.

## 1. Purpose and audience

Students loading their own BLAST results and needing to understand them: which queries got good hits, which didn't, what those hits are, and how to take the relevant sequences forward into alignment and phylogenetic analysis (built elsewhere, including in Clann Tree Viewer). The tool summarises, filters, and visualises. It does not run BLAST, does not fetch sequences from the internet, and does not build alignments or trees itself.

## 2. Non-negotiable constraints

These carry over directly from `clann-tree-viewer` and are not open for reinterpretation:

- **Browser-only, no backend.** Everything runs client-side. Nothing is uploaded to a server. This must be stated explicitly in the UI, the same way the tree viewer states it.
- **No build step.** Plain ES modules, no bundler, no framework. Runs from any static file server (`python3 -m http.server`) with zero install.
- **No external runtime dependencies.** No CDN-loaded libraries for parsing, charting, or rendering. Charts and diagrams are drawn with hand-written SVG/Canvas, exactly as the tree viewer draws its own tree renderer without a charting library.
- **GPL-2.0 licence**, matching the sibling repo.
- **GitHub Pages hosting** at a URL parallel to the tree viewer, e.g. `chriscreevey.github.io/clann-blast-explorer/`.
- **Theme-aware light/dark styling**, reusing the same CSS variable approach as `styles/viewer.css` in the tree viewer rather than inventing a new palette.

## 3. Repository layout

Mirror the tree viewer's layout exactly, substituting content:

```
index.html              App shell (upload UI + explorer markup)
styles/explorer.css      Styles (theme-aware, light/dark; port variables from viewer.css)
src/
  app.js                 Upload glue: File(s) → parse() → explorer
  explorer.js             Interactive UI: mountExplorer(container, data)
  parse/
    blast-tabular.js      outfmt 6/7 parser, column detection, DIAMOND compatibility
    fasta.js               FASTA parser + ID-matching subsetter
    index.js               detectFormat() + parse() → ExplorerData
  analysis/
    summary.js             per-query and global summary calculations
    filters.js              threshold/taxon filtering logic
    rbh.js                  reciprocal best hit computation
  render/
    hit-table.js            sortable/filterable table component
    hit-span.js              per-query HSP coverage diagram (SVG)
    charts.js                histograms, scatter plots (SVG)
    taxonomy.js              taxonomy bar/pie chart (SVG)
export/
  fasta-export.js          FASTA subset export (query/subject/combined)
  table-export.js          CSV/TSV export
examples/                 Sample BLAST/FASTA files (see Section 9, placeholder)
test/                     Fixture-driven parser and analysis tests
.github/                  (mirror tree viewer's workflow files if present)
sitemap.xml
robots.txt
og-image.png / og-image.svg
LICENSE                  GPL-2.0
README.md
```

Keep `ExplorerData` as the single internal document shape that every renderer consumes, exactly as `ViewerData` works in the tree viewer — parsers' only job is to turn uploaded text into that shape.

## 4. Data model

Sketch (finalise field names during implementation, but keep this shape):

```js
ExplorerData = {
  meta: {
    sourceFilename,
    format,              // 'blast-outfmt6' | 'blast-outfmt7' | 'diamond' | 'ncbi-hittable'
    columns,             // ordered list of detected/mapped column names
    hasTaxonomy,         // boolean: staxids/sscinames present
    hasSequences,        // boolean: qseq/sseq columns present
  },
  hits: [
    {
      qseqid, sseqid, pident, length, mismatch, gapopen,
      qstart, qend, sstart, send, evalue, bitscore,
      qlen, slen, qcovs,           // optional
      staxids, sscinames, scomnames, sskingdoms,  // optional
      qseq, sseq,                   // optional
      stitle,                       // optional
    },
    // ...
  ],
  queries: [ /* derived: unique qseqid list, with hit count and best hit reference */ ],
}
```

RBH mode operates on two `ExplorerData` objects (forward and reverse run) and produces a separate derived structure — do not try to force it into a single `ExplorerData`.

## 5. Input handling and parsing

- Accept file picker, drag-and-drop, and paste-into-window, matching the tree viewer's interaction pattern exactly (including the paste shortcut behaviour).
- Detect `-outfmt 7` by the leading `# Fields:` comment line; parse column names directly from it.
- For headerless `-outfmt 6` input, default to the standard 12-column order, but verify column count against detected data (numeric columns should be numeric, `pident` should be 0–100, `evalue` should parse as a float/scientific notation) and prompt a manual column-mapping step if detection is ambiguous or the count doesn't match.
- Recognise optional columns positionally or by name where the `# Fields:` line is present: `qlen`, `slen`, `staxids`, `sscinames`, `scomnames`, `sskingdoms`, `qcovs`/`qcovhsp`, `stitle`, `qseq`, `sseq`.
- Support DIAMOND's default tabular output as a variant of the same 12-column format.
- Support the NCBI web BLAST "Hit Table" download format as a fourth input variant if its columns differ meaningfully from `-outfmt 6` — confirm actual column layout during implementation by testing against a real export rather than assuming.
- Multi-query files are the default case, not a special case. Every view must work sensibly whether the file contains one query or thousands.

## 6. Features

Build in the phases below. Each phase should be a working, demoable state.

### Phase 1 — Load, parse, per-query view
- File load (picker/drag-drop/paste) with format auto-detection and manual column mapping fallback
- Query list/selector
- Ranked hit table for the selected query (sortable columns)
- Best-hit summary card
- Hit-span diagram: query as a bar, HSPs as coloured segments along it, showing coverage and overlap

### Phase 2 — Across-queries summary and filtering
- Per-query summary table (hit count, best hit, best %identity/e-value, best taxon if available)
- Live filtering: %identity, e-value, bit score, alignment length, query coverage thresholds; exclude self-hits; top-N-per-query cap; taxon include/exclude when taxonomy present
- "No hit" / "weak hit" flagging against the active thresholds
- Distribution charts: %identity, e-value (log scale), bit score, alignment length, query coverage — toggle between all-hits and best-hit-only
- %identity vs coverage scatter, colourable by e-value or taxon
- Taxonomy bar/pie chart when `staxids`/`sscinames` present; fall back to a genus/species heuristic parsed from `stitle` when absent, clearly labelled as approximate

### Phase 3 — RBH mode
- Load a second (reverse) BLAST file
- Compute reciprocal best hits under the currently active thresholds
- Three-way classification per query: reciprocal / one-way / no hit, with counts and a summary bar chart
- RBH pair table (query, partner, forward and reverse %identity/e-value), exportable
- Forward-vs-reverse %identity scatter for RBH pairs

### Phase 4 — FASTA integration and export
- Direct FASTA export from `qseq`/`sseq` columns when present, respecting the active filter/selection
- Upload original query FASTA; ID-match against `qseqid`; export a subset FASTA based on the active filter/selection (e.g. queries with no hit, queries below a threshold, queries matching a taxon)
- Upload subject/hit FASTA; ID-match against `sseqid`; export a subset of hit sequences for the current selection
- Combined export (query + matched hit sequences together) for direct use in an alignment tool
- Accession list / FASTA-header-only export for cases where sequences aren't locally available, for use with NCBI Batch Entrez or similar
- CSV/TSV export of the current filtered table

### Phase 5 — polish and parity with the tree viewer
- Theme toggle, resizable panels, responsive layout
- Deep-link example loading (`?data=examples/...`)
- FAQ section on the landing page
- Footer: Feedback / GitHub / ★ Like it? links, same phrasing as the tree viewer
- `sitemap.xml`, `robots.txt`, OG/Twitter meta tags, canonical URL

## 7. UI/UX conventions to replicate exactly

- Header: persistent tool name top-left ("Clann BLAST Explorer"), current file name(s) beside it
- Collapsible sidebar control panel; main canvas/table area; theme toggle; resizable panel width
- Drag-and-drop target with the same visual treatment as the tree viewer
- Undo where it makes sense (e.g. reverting a filter change), matching the tree viewer's undo pattern if feasible
- Same footer link set and phrasing: `Feedback` (GitHub issues new), `GitHub` (source), `★ Like it?` (star the repo)
- Same landing-page structure: short description, format badges (equivalent of the tree viewer's extension list), "Open file…" button, About & FAQ below the fold

## 8. What this tool explicitly does not do

State these clearly in the README and on the page itself, so students and anyone reusing the tool understand the scope:

- Does not run BLAST or DIAMOND searches
- Does not fetch sequences from NCBI/UniProt/EBI automatically (links out only)
- Does not build alignments or trees (stages data for tools that do, including Clann Tree Viewer)
- Does not upload any data anywhere

## 9. Outstanding items — placeholders

These were flagged during scoping and are not yet resolved. Do not block implementation on them, but leave clearly marked placeholders and flag them in the README as TODO:

- **§9a. Additional analyses from teaching practice.** Chris to supply any further analyses used in teaching that aren't covered above (e.g. contamination screening for unexpected taxa in a hit set, specific identity/coverage rules of thumb, or a figure type currently drawn by hand). Leave a `// TODO: additional analyses pending` marker in `src/analysis/summary.js`.
- **§9b. Example data.** The `examples/` directory needs real BLAST output files: at minimum one with taxonomy columns, one without, and a forward/reverse pair for the RBH example. Until supplied, generate minimal synthetic placeholder examples (clearly labelled as synthetic, not real data) so Phase 1–3 development and testing aren't blocked, and swap in real files once provided.
- **§9c. NCBI web BLAST hit-table column layout.** Confirm against a real exported file before building the fourth format variant in Section 5; don't guess the column set.

## 10. Development and testing

- No build step: `python3 -m http.server 8000`, then open `index.html`
- Fixture-driven tests for parsing (`node --test`), covering: standard `-outfmt 6`, `-outfmt 7` with `# Fields:`, DIAMOND output, files with taxonomy columns, files with `qseq`/`sseq`, malformed/ambiguous column counts (should trigger the mapping UI, not crash)
- Fixture-driven tests for RBH computation, including edge cases (a query with no hit in one direction, ties in bit score)
- Fixture-driven tests for FASTA ID-matching (partial ID match, version-suffix mismatch e.g. `ABC123.1` vs `ABC123`, duplicate IDs)

## 11. Reference implementation

Treat `https://github.com/ChrisCreevey/clann-tree-viewer` as the canonical reference for tone, structure, and conventions throughout. When in doubt about a UI or architectural decision not covered explicitly above, match what that repository does.
