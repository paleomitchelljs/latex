/* LaTeX editor with SyncTeX click-sync.
 * PDF click  -> highlight the matching source line/word in the editor.
 * Alt-click (or line-number click) in the editor -> highlight in the PDF.
 */
'use strict';

pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';

const params = new URLSearchParams(location.search);
const TOKEN = params.get('token') || '';

const state = {
  path: null,          // absolute path of the open file, or null for untitled
  name: 'untitled.tex',
  mtime: null,         // last-known on-disk mtime, for external-edit detection
  dirty: false,
  compiling: false,
  compileQueued: false,
  pdfDoc: null,
  pdfData: null,       // last PDF bytes, for re-render on zoom/resize
  pages: [],           // {wrapper, canvas, viewport, page}
  synctex: null,       // parsed synctex data
  compileDir: null,
  mainfile: null,
  mainTag: null,       // synctex input tag of the open file
  zoom: 'fit',         // 'fit' or a number (1 = 100%)
  autoCompile: true,
  textCache: {},       // pageNo -> pdf.js text items (for word lookup)
  observer: null,      // IntersectionObserver driving lazy page painting
  renderedOrder: [],   // LRU list of painted pages
};

const $ = (id) => document.getElementById(id);

/* ---------------- editor ---------------- */

const editor = CodeMirror.fromTextArea($('code'), {
  mode: 'stex',
  lineNumbers: true,
  lineWrapping: true,
  styleActiveLine: true,
  matchBrackets: true,
  indentUnit: 2,
  tabSize: 2,
});

editor.on('change', () => {
  setDirty(true);
  if (state.autoCompile) scheduleCompile();
});

// Alt-click anywhere in the text -> sync to PDF
editor.getWrapperElement().addEventListener('mousedown', (e) => {
  if (!e.altKey) return;
  e.preventDefault();
  const pos = editor.coordsChar({ left: e.clientX, top: e.clientY }, 'window');
  syncSourceToPdf(pos.line);
});

// Clicking a line number also syncs
editor.on('gutterClick', (cm, line) => syncSourceToPdf(line));

/* ---------------- api helpers ---------------- */

async function api(path, body) {
  const opts = body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Auth-Token': TOKEN }, body: JSON.stringify(body) }
    : { headers: { 'X-Auth-Token': TOKEN } };
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (res.status === 403) {
    throw new Error('unauthorized — open the exact URL that serve.py printed (it contains the session token)');
  }
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

/* Replace the buffer programmatically without tripping the auto-compile
 * that the change event schedules. */
function setSource(text) {
  editor.setValue(text);
  editor.clearHistory();
  clearTimeout(compileTimer);
  setDirty(false);
}

/* ---------------- file ops ---------------- */

function setDirty(d) {
  state.dirty = d;
  $('dirtyDot').hidden = !d;
}

function setFile(path, name) {
  state.path = path;
  state.name = name || (path ? path.split('/').pop() : 'untitled.tex');
  $('fileName').textContent = state.name;
  $('fileName').title = path || 'not saved to disk yet';
  document.title = state.name + ' — LaTeX Editor';
}

async function loadFile(path) {
  try {
    const data = await api('/api/load' + (path ? '?path=' + encodeURIComponent(path) : ''));
    setFile(data.path, data.name);
    state.mtime = data.mtime || null;
    setSource(data.source);
    if (data.source.trim()) compile();
  } catch (err) {
    toast('Could not open file: ' + err.message);
  }
}

async function saveFile(force) {
  let path = state.path;
  if (!path) {
    path = window.prompt('Save as (absolute path):', '~/untitled.tex');
    if (!path) return false;
  }
  try {
    const data = await api('/api/save', {
      path, source: editor.getValue(),
      mtime: path === state.path ? state.mtime : null,
      force: !!force,
    });
    if (data.conflict) {
      if (confirm('This file changed on disk since it was loaded.\nOverwrite it with the editor contents?')) {
        return saveFile(true);
      }
      setStatus('⚠ not saved — file changed on disk (use Open to reload it)', 'err');
      return false;
    }
    setFile(data.path, data.name);
    state.mtime = data.mtime || null;
    setDirty(false);
    setStatus('saved ' + state.name, 'ok');
    return true;
  } catch (err) {
    toast('Save failed: ' + err.message);
    return false;
  }
}

/* ---------------- compile ---------------- */

let compileTimer = null;
function scheduleCompile() {
  clearTimeout(compileTimer);
  compileTimer = setTimeout(compile, 1200);
}

async function compile(manual, force) {
  if (state.compiling) { state.compileQueued = true; return; }
  state.compiling = true;
  clearTimeout(compileTimer);
  setStatus('compiling…', 'busy');
  const t0 = performance.now();
  const sent = editor.getValue();
  let redoForced = false;
  try {
    const res = await api('/api/compile',
      { source: sent, path: state.path, mtime: state.mtime, force: !!force });
    if (res.conflict) {
      // The file changed on disk (external editor, Dropbox sync, …).
      // Never overwrite silently from an auto-compile; ask on a manual one.
      if (manual) {
        redoForced = confirm('This file changed on disk since it was loaded.\nOverwrite it with the editor contents and compile?');
      }
      if (!redoForced) {
        setStatus('⚠ file changed on disk — Compile to overwrite, or Open to reload', 'err');
      }
      return;
    }
    state.compileDir = res.dir || null;
    state.mainfile = res.mainfile || null;
    if (res.mtime) state.mtime = res.mtime;
    // compile saves the file — but only mark clean if nothing changed meanwhile
    if (state.path && editor.getValue() === sent) setDirty(false);

    showErrors(res.errors || [], res.log || '');

    if (res.pdf) {
      const bytes = b64ToBytes(res.pdf);
      state.pdfData = bytes;
      if (res.synctex) {
        const raw = b64ToBytes(res.synctex);
        const text = res.gz ? pako.ungzip(raw, { to: 'string' }) : new TextDecoder().decode(raw);
        state.synctex = SyncTeX.parse(text);
        state.mainTag = findMainTag();
      } else {
        state.synctex = null;
      }
      await renderPdf(bytes);
    }
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    if (res.errors && res.errors.length) {
      setStatus(`✗ ${res.errors.length} error${res.errors.length > 1 ? 's' : ''} (${secs}s) — click "log"`, 'err');
    } else if (res.ok) {
      setStatus(`✓ compiled in ${secs}s`, 'ok');
    } else {
      setStatus('✗ compile failed — click "log"', 'err');
    }
  } catch (err) {
    setStatus('✗ ' + err.message, 'err');
  } finally {
    state.compiling = false;
    if (redoForced) compile(true, true);
    else if (state.compileQueued) { state.compileQueued = false; compile(); }
  }
}

function findMainTag() {
  if (!state.synctex) return null;
  const inputs = state.synctex.inputs;
  // Prefer exact resolved-path match, fall back to basename match.
  for (const [tag, p] of Object.entries(inputs)) {
    if (resolveInput(p) === (state.path || joinPath(state.compileDir, state.mainfile))) return tag;
  }
  for (const [tag, p] of Object.entries(inputs)) {
    if (basename(p) === state.mainfile) return tag;
  }
  return '1';
}

function basename(p) { return p.split('/').pop(); }
function joinPath(dir, name) { return dir ? dir.replace(/\/$/, '') + '/' + name : name; }

function resolveInput(p) {
  if (!p.startsWith('/')) p = joinPath(state.compileDir, p.replace(/^\.\//, ''));
  // normalize "a/b/../c" and "./"
  const parts = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop(); else parts.push(seg);
  }
  return '/' + parts.join('/');
}

/* ---------------- errors / log ---------------- */

let errLineHandles = [];
let lastErrSig = null;
function showErrors(errors, log) {
  errLineHandles.forEach((h) => editor.removeLineClass(h, 'background', 'err-line'));
  errLineHandles = [];
  $('logText').textContent = log;
  const list = $('errList');
  list.innerHTML = '';
  for (const e of errors) {
    const div = document.createElement('div');
    div.className = 'err-item';
    div.innerHTML = `<span class="loc">${e.file || ''}${e.line ? ':' + e.line : ''}</span>`;
    div.appendChild(document.createTextNode(e.message));
    if (e.line && e.line <= editor.lineCount() &&
        (!e.file || basename(e.file) === state.name || basename(e.file) === state.mainfile)) {
      div.addEventListener('click', () => highlightEditorLine(e.line - 1, null, false));
      const h = editor.addLineClass(e.line - 1, 'background', 'err-line');
      errLineHandles.push(h);
    }
    list.appendChild(div);
  }
  // Auto-open the log only when the error set changes, so it doesn't
  // reappear on every auto-compile after the user dismissed it.
  const sig = errors.map((e) => `${e.file}:${e.line}:${e.message}`).join('|');
  if (!errors.length) $('logPanel').hidden = true;
  else if (sig !== lastErrSig) $('logPanel').hidden = false;
  lastErrSig = sig;
}

/* ---------------- pdf rendering ---------------- */

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* Pages are laid out immediately as correctly-sized placeholders; canvases
 * are painted lazily as they scroll near the viewport, and the least
 * recently used ones are evicted so long documents don't exhaust memory.
 * Pages visible at swap time are painted first so recompiles don't flash. */
const PAGE_GAP = 16;           // matches #pdfPages gap / #pdfScroll padding
const MAX_RENDERED = 24;

async function renderPdf(bytes) {
  const doc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
  const scroll = $('pdfScroll');
  const keepTop = scroll.scrollTop, keepLeft = scroll.scrollLeft;

  const pageObjs = await Promise.all(
    Array.from({ length: doc.numPages }, (_, i) => doc.getPage(i + 1)));

  const baseW = pageObjs[0].getViewport({ scale: 1 }).width;
  const scale = state.zoom === 'fit'
    ? Math.max((scroll.clientWidth - 36) / baseW, 0.3)
    : state.zoom;

  const frag = document.createDocumentFragment();
  const infos = [];
  for (const page of pageObjs) {
    const viewport = page.getViewport({ scale });
    const wrapper = document.createElement('div');
    wrapper.className = 'page';
    wrapper.dataset.page = page.pageNumber;
    wrapper.style.width = viewport.width + 'px';
    wrapper.style.height = viewport.height + 'px';
    frag.appendChild(wrapper);
    infos.push({ wrapper, viewport, page, canvas: null, rendering: false });
  }
  state.renderedOrder = [];

  // paint the pages that will be visible before swapping in the new DOM
  const visible = [];
  let y = PAGE_GAP;
  for (const info of infos) {
    if (y + info.viewport.height >= keepTop && y <= keepTop + scroll.clientHeight) {
      visible.push(info);
    }
    y += info.viewport.height + PAGE_GAP;
  }
  await Promise.all(visible.map(paintPage));

  if (state.observer) state.observer.disconnect();
  $('pdfPages').replaceChildren(frag);
  scroll.scrollTop = keepTop;
  scroll.scrollLeft = keepLeft;

  if (state.pdfDoc) state.pdfDoc.destroy();
  state.pdfDoc = doc;
  state.pages = infos;
  state.textCache = {};

  state.observer = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      const info = infos[parseInt(en.target.dataset.page, 10) - 1];
      if (info) paintPage(info);
    }
  }, { root: scroll, rootMargin: '800px 0px' });
  infos.forEach((info) => state.observer.observe(info.wrapper));
}

async function paintPage(info) {
  if (info.canvas || info.rendering) return;
  info.rendering = true;
  try {
    const dpr = window.devicePixelRatio || 1;
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(info.viewport.width * dpr);
    canvas.height = Math.floor(info.viewport.height * dpr);
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    await info.page.render({
      canvasContext: canvas.getContext('2d'),
      viewport: info.viewport,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
    }).promise;
    info.wrapper.prepend(canvas); // prepend keeps highlight overlays on top
    info.canvas = canvas;
    // LRU eviction: far-away pages lose their canvas; the observer
    // repaints them if they scroll back into range.
    const order = state.renderedOrder;
    order.push(info);
    while (order.length > MAX_RENDERED) {
      const old = order.shift();
      if (old === info) { order.push(info); break; }
      if (old.canvas) { old.canvas.remove(); old.canvas = null; }
    }
  } finally {
    info.rendering = false;
  }
}

/* ---------------- sync: PDF -> source ---------------- */

$('pdfPages').addEventListener('click', async (e) => {
  const wrapper = e.target.closest('.page');
  if (!wrapper || !state.synctex) return;
  const pageNo = parseInt(wrapper.dataset.page, 10);
  const info = state.pages[pageNo - 1];
  if (!info) return;

  const rect = wrapper.getBoundingClientRect();
  const cssX = e.clientX - rect.left;
  const cssY = e.clientY - rect.top;

  // click marker
  const mark = document.createElement('div');
  mark.className = 'click-mark';
  mark.style.left = cssX + 'px';
  mark.style.top = cssY + 'px';
  wrapper.appendChild(mark);
  setTimeout(() => mark.remove(), 1300);

  const [px, py] = info.viewport.convertToPdfPoint(cssX, cssY);
  const pageH = info.page.view[3] - info.page.view[1];
  const hit = SyncTeX.forward(state.synctex, pageNo, px, pageH - py);
  if (!hit) { setStatus('no sync info at that spot', ''); return; }

  const inputPath = state.synctex.inputs[hit.tag];
  const resolved = inputPath ? resolveInput(inputPath) : null;
  const isMain = hit.tag === state.mainTag;

  if (!isMain && resolved && basename(resolved) !== state.name) {
    if (confirm(`That text is from ${basename(resolved)} (line ${hit.line}). Open it?`)) {
      await loadFile(resolved);
      highlightEditorLine(hit.line - 1, null, true);
    }
    return;
  }

  const word = await wordAtPdfPoint(info, pageNo, px, py);
  highlightEditorLine(hit.line - 1, word, true);
});

/* Find the word under a PDF point using the pdf.js text layer. */
async function wordAtPdfPoint(info, pageNo, px, py) {
  try {
    if (!state.textCache[pageNo]) {
      state.textCache[pageNo] = (await info.page.getTextContent()).items;
    }
    for (const item of state.textCache[pageNo]) {
      if (!item.str || !item.width) continue;
      const x0 = item.transform[4], y0 = item.transform[5];
      const h = Math.hypot(item.transform[1], item.transform[3]) || item.height || 10;
      if (px < x0 || px > x0 + item.width) continue;
      if (py < y0 - 0.25 * h || py > y0 + h) continue;
      const idx = Math.max(0, Math.min(item.str.length - 1,
        Math.floor(((px - x0) / item.width) * item.str.length)));
      const isWordChar = (ch) => /[\wÀ-ɏ'-]/.test(ch);
      if (!isWordChar(item.str[idx])) return null;
      let a = idx, b = idx;
      while (a > 0 && isWordChar(item.str[a - 1])) a--;
      while (b < item.str.length - 1 && isWordChar(item.str[b + 1])) b++;
      const w = item.str.slice(a, b + 1);
      return w.length >= 2 ? w : null;
    }
  } catch (e) { /* text layer is best-effort */ }
  return null;
}

let syncLineHandle = null;
function highlightEditorLine(line, word, focus) {
  if (line < 0 || line >= editor.lineCount()) return;
  if (syncLineHandle !== null) editor.removeLineClass(syncLineHandle, 'background', 'sync-line');

  editor.scrollIntoView({ line, ch: 0 }, 120);
  let selected = false;
  if (word) {
    const text = editor.getLine(line);
    const at = text.indexOf(word);
    if (at >= 0) {
      editor.setSelection({ line, ch: at }, { line, ch: at + word.length });
      selected = true;
    }
  }
  if (!selected) editor.setCursor({ line, ch: 0 });

  syncLineHandle = editor.addLineClass(line, 'background', 'sync-line');
  const handle = syncLineHandle;
  setTimeout(() => {
    if (handle === syncLineHandle) {
      editor.removeLineClass(handle, 'background', 'sync-line');
      syncLineHandle = null;
    }
  }, 2400);
  if (focus) editor.focus();
}

/* ---------------- sync: source -> PDF ---------------- */

function syncSourceToPdf(line0) {
  if (!state.synctex || !state.mainTag) { toast('Compile first to enable sync.'); return; }
  const hit = SyncTeX.reverse(state.synctex, state.mainTag, line0 + 1);
  if (!hit) { toast(`No PDF match for line ${line0 + 1}.`); return; }

  const info = state.pages[hit.page - 1];
  if (!info) return;
  const pageH = info.page.view[3] - info.page.view[1];

  document.querySelectorAll('.sync-highlight').forEach((el) => el.remove());
  let firstEl = null;
  for (const r of hit.rects) {
    // synctex top-left origin -> pdf bottom-left -> viewport css px
    const [vx0, vy0] = info.viewport.convertToViewportPoint(r.left, pageH - r.top);
    const [vx1, vy1] = info.viewport.convertToViewportPoint(r.left + r.width, pageH - (r.top + r.height));
    const el = document.createElement('div');
    el.className = 'sync-highlight';
    el.style.left = Math.min(vx0, vx1) - 2 + 'px';
    el.style.top = Math.min(vy0, vy1) - 1 + 'px';
    el.style.width = Math.abs(vx1 - vx0) + 4 + 'px';
    el.style.height = Math.abs(vy1 - vy0) + 2 + 'px';
    info.wrapper.appendChild(el);
    if (!firstEl) firstEl = el;
    setTimeout(() => el.remove(), 2500);
  }
  if (firstEl) firstEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

/* ---------------- toolbar / status ---------------- */

function setStatus(msg, cls) {
  const el = $('status');
  el.textContent = msg;
  el.className = cls || '';
}

let toastTimer = null;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
}

$('btnNew').addEventListener('click', () => {
  if (state.dirty && !confirm('Discard unsaved changes?')) return;
  setFile(null, 'untitled.tex');
  state.mtime = null;
  setSource(TEMPLATE);
});

$('btnOpen').addEventListener('click', () => {
  const path = window.prompt('Open file (absolute path):', state.path || '~/');
  if (path) loadFile(path);
});

$('btnSave').addEventListener('click', () => saveFile());
$('btnCompile').addEventListener('click', () => compile(true));
$('chkAuto').addEventListener('change', (e) => { state.autoCompile = e.target.checked; });

$('btnLog').addEventListener('click', () => { $('logPanel').hidden = !$('logPanel').hidden; });
$('btnCloseLog').addEventListener('click', () => { $('logPanel').hidden = true; });

function setZoom(z) {
  state.zoom = z;
  if (state.pdfData) renderPdf(state.pdfData);
}
$('btnZoomIn').addEventListener('click', () => {
  const cur = state.zoom === 'fit' ? currentScale() : state.zoom;
  setZoom(Math.min(cur * 1.2, 5));
});
$('btnZoomOut').addEventListener('click', () => {
  const cur = state.zoom === 'fit' ? currentScale() : state.zoom;
  setZoom(Math.max(cur / 1.2, 0.3));
});
$('btnZoomFit').addEventListener('click', () => setZoom('fit'));
function currentScale() { return state.pages[0] ? state.pages[0].viewport.scale : 1; }

// keyboard shortcuts
document.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key === 's') { e.preventDefault(); saveFile(); }
  if (mod && e.key === 'Enter') { e.preventDefault(); compile(true); }
});

window.addEventListener('beforeunload', (e) => {
  if (state.dirty) { e.preventDefault(); e.returnValue = ''; }
});

// draggable divider
(() => {
  const divider = $('divider');
  const editorPane = $('editorPane');
  let dragging = false;
  divider.addEventListener('mousedown', (e) => { dragging = true; e.preventDefault(); });
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const total = $('split').clientWidth;
    const frac = Math.min(0.8, Math.max(0.15, e.clientX / total));
    editorPane.style.flexBasis = (frac * 100) + '%';
    editor.refresh();
  });
  document.addEventListener('mouseup', () => {
    if (dragging && state.zoom === 'fit' && state.pdfData) renderPdf(state.pdfData);
    dragging = false;
  });
})();

// re-fit PDF on window resize
let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (state.zoom === 'fit' && state.pdfData) renderPdf(state.pdfData);
  }, 250);
});

/* ---------------- boot ---------------- */

const TEMPLATE = `\\documentclass[11pt]{article}
\\usepackage[margin=1in]{geometry}
\\usepackage{amsmath, amssymb}

\\title{Untitled}
\\author{}
\\date{\\today}

\\begin{document}
\\maketitle

Hello, world. Click anywhere in the PDF to jump to the matching
line here; alt-click a line here to highlight it in the PDF.

\\end{document}
`;

(async function boot() {
  $('pdfPages').innerHTML = '<div id="pdfEmpty">Compile to see the PDF</div>';
  try {
    const data = await api('/api/load');
    if (data.path) {
      setFile(data.path, data.name);
      state.mtime = data.mtime || null;
      setSource(data.source);
    } else {
      setFile(null, 'untitled.tex');
      setSource(TEMPLATE);
    }
    compile();
  } catch (err) {
    setFile(null, 'untitled.tex');
    setSource(TEMPLATE);
    setStatus('✗ ' + err.message, 'err');
    toast(err.message);
  }
})();
