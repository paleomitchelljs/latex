# TeXsync — a LaTeX editor with click-to-source sync

A small browser-based LaTeX editor that shows the `.tex` source and the
rendered PDF side by side, with **bidirectional SyncTeX highlighting**:

- **Click anywhere in the PDF** → the matching source line is highlighted in
  the editor, and where possible the specific word you clicked is selected.
- **Alt-click a line in the editor** (or click its line number) → the
  matching region of the PDF is highlighted and scrolled into view.

It runs in two modes with the same UI:

1. **Local mode** — a tiny Python server (standard library only) compiles
   through your local TeX installation with `-synctex=1`.
2. **In-browser mode (GitHub Pages)** — opened as a static page, it compiles
   with a real pdfTeX built to WebAssembly ([busytex](https://github.com/busytex/busytex),
   with a TeX Live basic tree + latex-recommended/fonts/science bundles).
   No server, no install: the engine (~140 MB) downloads on first use and is
   cached by the browser (Cache Storage) afterwards. SyncTeX works
   identically in both modes.

## In-browser mode (the GitHub Pages deployment)

- **Open** uploads files: the first `.tex` becomes the document; figures,
  `.bib`, `.cls`/`.sty`, and `\input` files join the project (see the
  "+N files" badge). Drag-and-drop works too. `\RequirePackage` lines inside
  uploaded classes/styles are scanned so the TeX bundles they need are
  fetched automatically. Text project files survive a reload (localStorage);
  re-upload figures after reloading.
- **Save** downloads the `.tex`; **PDF ↓** downloads the compiled PDF.
- The document autosaves to localStorage, so reloading the page restores it.
- BibTeX runs automatically (bibtex8) when the document has a
  `\bibliography`.
- Font note: the WASM tree cannot rasterize Computer Modern bitmap fonts
  (no Metafont), so documents that need them (e.g. `\textbullet` via the
  TS1 encoding) are automatically retried with `\usepackage{lmodern}` —
  Latin Modern, visually near-identical, injected on the `\documentclass`
  line so SyncTeX line numbers are unaffected.
- Packages beyond the bundled collections (basic + latex-base +
  latex-recommended + fonts-recommended + science) are not available; the
  status bar names anything unresolved.

## Local mode usage

```sh
python3 serve.py example.tex        # open a file
python3 serve.py                    # start with an untitled document
python3 serve.py paper.tex --engine xelatex
python3 serve.py thesis.tex --engine latexmk   # for bibtex/biber projects
```

Your browser opens automatically. Options: `--port N` (default 8123),
`--no-browser`.

## Editor

| Action | How |
|---|---|
| Compile | `⌘⏎` or the Compile button (auto-compiles as you type by default) |
| Save | `⌘S` |
| Find / replace | `⌘F` / `⌘⌥F` in the editor; `⌘G` next match |
| PDF → source | click in the PDF |
| Source → PDF | alt-click in the text, or click a line number |
| Compile log / errors | "log" button in the status bar; error entries jump to the line |
| Zoom | − / fit / + in the toolbar |

Notes:

- **Compiling saves the file** (like TeXShop): with auto-compile on, the
  file on disk tracks the editor. Turn off "auto" if you don't want that.
- If the file changes on disk outside the editor (another program, Dropbox
  sync), the editor refuses to overwrite it: auto-compile pauses with a
  status warning, and a manual Compile/Save asks before overwriting.
- Reloading the browser tab restores the last file you had open.
- Pages render lazily as you scroll, so long documents stay fast.
- Compilation runs in the file's own directory, so `\input`, images, and
  `.bib` files resolve normally. Aux files appear next to your `.tex` file
  as usual.
- If you click PDF text that came from an `\input`ed file, the editor
  offers to open that file.
- The server binds to 127.0.0.1 only and requires a per-session token
  (embedded in the URL it opens), so other websites/machines can't reach it.

## Files

- `serve.py` — local server: static files + `/api/compile|load|save`
- `index.html`, `style.css`, `app.js` — the UI (CodeMirror + pdf.js)
- `synctex.js` — SyncTeX parser and forward/reverse query logic
- `vendor/` — vendored libraries (works offline)
- `wasm/` — in-browser engine: `texsync-worker.js` (our worker: synctex,
  reruns, caching, lmodern fallback) wrapping `busytex_pipeline.js` and the
  busytex WASM/TeX Live binaries (MIT-licensed, from the busytex project)
- `example.tex` — two-page demo exercising the sync

## How the sync works

`pdflatex -synctex=1` writes a `.synctex.gz` file recording, for every box
TeX places on the page, the source file and line that produced it.
`synctex.js` parses that into per-page box lists (converted to PDF points).
A click in the PDF is converted to page coordinates via pdf.js, the
smallest enclosing box is found, and its per-word records refine the match
to a source line; the pdf.js text layer supplies the clicked word. The
reverse direction collects the boxes recorded for a source line and
overlays highlights on the page. The query logic was validated against the
reference `synctex` CLI from TeX Live.
