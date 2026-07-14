/* Web Worker: in-browser LaTeX compilation via busytex, with SyncTeX.
 *
 * Wraps BusytexPipeline (busytex_pipeline.js, vendored from
 * github.com/busytex/busytex) and adds:
 *   - --synctex=1 --file-line-error, no --halt-on-error (we want partial
 *     PDFs and a parseable log, like the local-server backend)
 *   - reads .synctex.gz back out of the in-memory FS after compiling
 *   - "Rerun to get cross-references" second passes
 *   - chunked download of texlive-basic.data (GitHub caps files at 100 MB)
 *   - Cache API storage so the engine downloads once per browser
 *   - download progress messages
 *
 * Message API:
 *   -> {type:'init', config:{packages:[js names], chunks:{name:[urls]}}}
 *   -> {type:'compile', id, files:[{path, contents}], main}
 *   <- {type:'progress', label, loaded, total}
 *   <- {type:'status', message}
 *   <- {type:'ready'}
 *   <- {type:'result', id, ok, pdf, synctex, gz, log}
 *   <- {type:'error', id?, message}
 */
'use strict';

importScripts('busytex_pipeline.js');

let CONFIG = null;
let pipeline = null;

const post = (type, extra) => self.postMessage(Object.assign({ type }, extra || {}));

const CACHE_NAME = 'texsync-engine-v1';

/* Cache-first fetch with download progress for the big binaries. */
async function fetchBig(url, label) {
  const cache = 'caches' in self ? await caches.open(CACHE_NAME).catch(() => null) : null;
  if (cache) {
    const hit = await cache.match(url);
    if (hit) return hit;
  }
  const res = await self.__origFetch(url);
  if (!res.ok) throw new Error('download failed (' + res.status + '): ' + url);
  const total = +res.headers.get('Content-Length') || 0;
  const reader = res.body.getReader();
  const parts = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    loaded += value.length;
    post('progress', { label, loaded, total });
  }
  const type = url.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream';
  const blob = new Blob(parts, { type });
  const out = new Response(blob, { headers: { 'Content-Type': type } });
  if (cache) await cache.put(url, out.clone()).catch(() => {});
  return out;
}

/* Assemble a (possibly chunked) .data file into one ArrayBuffer. */
async function fetchDataFile(name) {
  const chunkList = (CONFIG.chunks && CONFIG.chunks[name]) || [name];
  const buffers = [];
  for (const c of chunkList) buffers.push(await (await fetchBig(c, name)).arrayBuffer());
  if (buffers.length === 1) return buffers[0];
  const size = buffers.reduce((s, b) => s + b.byteLength, 0);
  const out = new Uint8Array(size);
  let off = 0;
  for (const b of buffers) { out.set(new Uint8Array(b), off); off += b.byteLength; }
  return out.buffer;
}

/* Route the pipeline's own fetch of busytex.wasm through the cache. */
self.__origFetch = self.fetch.bind(self);
self.fetch = (url, opts) =>
  (typeof url === 'string' && url.endsWith('.wasm'))
    ? fetchBig(url, 'engine (busytex.wasm)')
    : self.__origFetch(url, opts);

/* The emscripten data-package loaders (texlive-basic.js etc., generated
 * with export name BusytexPipeline — that is why the pipeline keeps
 * preRun/calledRun/locateFile as statics on the class) download their
 * .data via XMLHttpRequest. Intercept those so the payloads go through
 * the chunk-aware, Cache-API-backed, progress-reporting path. */
const OrigXHR = self.XMLHttpRequest;
self.XMLHttpRequest = class {
  open(method, url) { this._url = String(url); }
  send() {
    if (this._url.endsWith('.data')) {
      const name = this._url.split('/').pop();
      fetchDataFile(name).then((buf) => {
        this.status = 200;
        this.response = buf;
        if (this.onload) this.onload({});
      }).catch((e) => {
        if (this.onerror) this.onerror(e); else throw e;
      });
      return;
    }
    // anything else: fall back to a real XHR
    const xhr = new OrigXHR();
    xhr.open('GET', this._url, true);
    xhr.responseType = this.responseType || '';
    xhr.onload = () => { this.status = xhr.status; this.response = xhr.response; this.onload && this.onload({}); };
    xhr.onerror = (e) => this.onerror && this.onerror(e);
    xhr.send(null);
  }
};

/* The basic TeX tree has no Type1 fonts for the TS1 companion encoding
 * (e.g. tcrm1095, used by \textbullet in itemize), and WASM cannot run
 * mktexpk to rasterize them like a real TeX install would. Latin Modern
 * IS in the tree and covers everything, so on a missing-font failure we
 * retry with \usepackage{lmodern} appended to the \documentclass line —
 * same line, so SyncTeX line numbers are unaffected. */
let lmodernSticky = false;

/* Insurance: if anything ever makes TeX read from the terminal (emscripten
 * has no real stdin in a worker), answer EOF instead of hanging. Runs in
 * the module's preRun phase, where the pipeline points the class's
 * prototype at the live emscripten Module. */
BusytexPipeline.preRun.push(function () {
  const M = Object.getPrototypeOf(BusytexPipeline);
  if (M && typeof M === 'object' && !M.stdin) M.stdin = () => null;
});

/* Packages missing from every busytex bundle (e.g. multirow) live as plain
 * .sty files in texmf/ next to this worker. Fetched on first use (null when
 * we don't vendor it either), kept for the session, and injected into the
 * project dir alongside the main file. */
const vendoredSty = new Map();
function fetchVendoredSty(name) {
  if (!/^[\w.-]+$/.test(name)) return Promise.resolve(null);
  if (!vendoredSty.has(name))
    vendoredSty.set(name, self.__origFetch('texmf/' + name + '.sty')
      .then((r) => (r.ok ? r.text() : null))
      .catch(() => null));
  return vendoredSty.get(name);
}

const TEXTISH = /\.(tex|sty|cls|def|cfg|bst|bib|clo)$/i;
const asText = (c) =>
  typeof c === 'string' ? c : (c && c.buffer ? new TextDecoder().decode(c) : '');

/* busytex's resolver only reads \usepackage lines in the main file — a
 * custom .cls/.sty whose \RequirePackage needs a non-preloaded bundle
 * would never trigger that bundle's download and the compile fails.
 * Harvest requirements from every text-ish project file, minus whatever
 * the uploads themselves provide. */
function harvestRequirements(files) {
  const wanted = new Set();
  for (const f of files) {
    if (!TEXTISH.test(f.path)) continue;
    for (const m of asText(f.contents)
        .matchAll(/\\(?:usepackage|RequirePackage)(?:\[[^\]]*\])?\{([^}]*)\}/g)) {
      for (const name of m[1].split(',')) {
        const p = name.trim();
        if (p) wanted.add(p);
      }
    }
  }
  for (const f of files) {
    const m = f.path.split('/').pop().match(/^(.+)\.(sty|cls)$/i);
    if (m) wanted.delete(m[1]);
  }
  return Array.from(wanted);
}

function injectLmodern(src) {
  if (/\\usepackage(\[[^\]]*\])?\{lmodern\}/.test(src)) return src;
  const out = src.replace(/(\\documentclass(?:\[[^\]]*\])?\{[^}]*\})/,
    '$1\\usepackage{lmodern}');
  return out;
}

class TexsyncPipeline extends BusytexPipeline {
  /* pdflatex with synctex; mirrors BusytexPipeline.compile()'s module and
   * FS management but with our own command sequence. */
  async compileTex(files, main_tex_path) {
    let result = await this.compileOnce(files, main_tex_path, lmodernSticky);
    if (!result.ok && /Font \S+ at \d+ not found|mktexpk/.test(result.log || '') && !lmodernSticky) {
      post('status', { message: 'missing bitmap font — retrying with Latin Modern (lmodern)' });
      result = await this.compileOnce(files, main_tex_path, true);
      if (result.ok) lmodernSticky = true;
    }
    return result;
  }

  async compileOnce(files, main_tex_path, useLmodern) {
    if (useLmodern) {
      files = files.map((f) =>
        f.path === main_tex_path && typeof f.contents === 'string'
          ? { path: f.path, contents: injectLmodern(f.contents) }
          : f);
    }
    // Hand the resolver a synthetic \usepackage line carrying every
    // requirement found across all project files (this also fixes their
    // untrimmed handling of "\usepackage{a, b}").
    const synthetic = harvestRequirements(files).map((p) => `\\usepackage{${p}}`).join('');
    const resolveFiles = files.map((f) =>
      f.path === main_tex_path && typeof f.contents === 'string'
        // normalize "{a, b}" -> "{a,b}" (their comma split doesn't trim),
        // then append the cross-file requirements
        ? { path: f.path,
            contents: f.contents.replace(/\\usepackage(\[[^\]]*\])?\{[^}]*\}/g, (m) => m.replace(/\s+/g, ''))
              + '\n' + synthetic }
        : f);
    const resolved = await this.data_package_resolver.resolve(resolveFiles, main_tex_path, null);
    const filter_map = (f, ret_pkg = true) =>
      Object.entries(resolved).filter(([p, v]) => f(v)).map(([p, v]) => (ret_pkg ? p : v.source));
    let data_packages_js = Array.from(new Set(
      filter_map((v) => v.used && v.source != 'local' && v.source != null, false))).sort();
    let unresolvedPkgs = filter_map((v) => v.source == null);
    if (unresolvedPkgs.length > 0) {
      const dir = main_tex_path.slice(0, main_tex_path.lastIndexOf('/') + 1);
      const still = [];
      for (const name of unresolvedPkgs) {
        const sty = await fetchVendoredSty(name);
        if (sty == null) { still.push(name); continue; }
        post('status', { message: name + '.sty is not in any bundle — using vendored copy' });
        files = files.concat([{ path: dir + name + '.sty', contents: sty }]);
      }
      unresolvedPkgs = still;
    }
    if (unresolvedPkgs.length > 0) {
      post('status', { message: 'packages not in any bundle: ' + unresolvedPkgs.join(', ') + ' — loading all bundles' });
      data_packages_js = this.data_package_resolver.data_packages_js;
    }

    this.Module = this.reload_module_if_needed(this.Module == null, this.env, this.project_dir, data_packages_js);
    const Module = await this.Module;
    const { FS, PATH } = Module;

    // fresh project dir for every compile
    if (FS.analyzePath(this.project_dir).object.mount.mountpoint == this.project_dir)
      FS.unmount(this.project_dir);
    FS.mount(FS.filesystems.MEMFS, {}, this.project_dir);
    const dirs = new Set(['/', this.project_dir]);
    for (const { path, contents } of [...files].sort((a, b) => (a.path < b.path ? -1 : 1))) {
      const abs = PATH.join(this.project_dir, path);
      if (contents == null) this.mkdir_p(FS, PATH, abs, dirs);
      else {
        this.mkdir_p(FS, PATH, PATH.dirname(abs), dirs);
        FS.writeFile(abs, contents);
      }
    }
    FS.chdir(PATH.join(this.project_dir, PATH.dirname(main_tex_path)));

    const tex = PATH.basename(main_tex_path);
    const job = tex.replace(/\.tex$/i, '');
    const pdftex = ['pdflatex', '--no-shell-escape', '--interaction=nonstopmode',
      '--file-line-error', '--synctex=1', '--output-format=pdf',
      '--fmt', this.fmt.pdftex, tex];
    const pdftexDraft = pdftex.slice(0, -1).concat(['--draftmode', tex]);
    const bibtex8 = ['bibtex8', '--8bit', job + '.aux'];

    // busytex trick: callMain repeatedly by snapshotting the static data
    // segment and zeroing the rest of the heap between runs.
    const mem_header = Uint8Array.from(Module.HEAPU8.slice(0, this.mem_header_size));
    const exec = (cmd) => {
      post('status', { message: '$ ' + cmd[0] + ' … ' + tex });
      const r = Module.callMainWithRedirects(cmd, false);
      Module.HEAPU8.fill(0);
      Module.HEAPU8.set(mem_header);
      return r;
    };

    const useBibtex = this.bibtex_resolver.resolve(files);
    if (useBibtex) {
      exec(pdftexDraft);
      exec(bibtex8);
      exec(pdftexDraft);
    }
    let run = exec(pdftex);
    let log = this.read_all_text(FS, job + '.log');
    for (let pass = 0; pass < 2 && /Rerun to get|Rerun LaTeX/.test(log); pass++) {
      run = exec(pdftex);
      log = this.read_all_text(FS, job + '.log');
    }

    const pdf = this.read_all_bytes(FS, job + '.pdf');
    let synctex = null, gz = false;
    for (const [name, isGz] of [[job + '.synctex.gz', true], [job + '.synctex', false]]) {
      const b = this.read_all_bytes(FS, name);
      if (b.length) { synctex = b; gz = isGz; break; }
    }
    return {
      ok: pdf.length > 0,
      pdf: pdf.length ? pdf : null,
      synctex, gz,
      log: log || run.stdout || run.stderr,
    };
  }
}

self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'init') {
      CONFIG = data.config;
      pipeline = new TexsyncPipeline(
        'busytex.js', 'busytex.wasm',
        CONFIG.packages, CONFIG.preload || ['texlive-basic.js'],
        [],                                    // texmf_local
        (msg) => {},                           // engine chatter: keep quiet
        () => post('ready'),                   // on_initialized
        true,                                  // keep module alive between compiles
        BusytexPipeline.ScriptLoaderWorker);
    } else if (data.type === 'compile') {
      if (!pipeline) throw new Error('engine not initialized');
      const res = await pipeline.compileTex(data.files, data.main);
      post('result', {
        id: data.id, ok: res.ok, pdf: res.pdf,
        synctex: res.synctex, gz: res.gz, log: res.log,
      });
    }
  } catch (err) {
    post('error', { id: data && data.id, message: err.message || String(err), stack: err.stack });
  }
};
