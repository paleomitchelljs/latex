#!/usr/bin/env python3
"""Local backend for the LaTeX editor.

Serves the static UI and exposes a small API that compiles LaTeX with
SyncTeX enabled using the local TeX installation.

Usage:
    python3 serve.py [file.tex] [--port 8123] [--engine pdflatex] [--no-browser]

API (all under /api/, require the per-session token):
    GET  /api/load?path=...          -> {path, name, source}
    POST /api/save    {path, source} -> {ok}
    POST /api/compile {source, path} -> {ok, pdf, synctex, gz, log, errors, dir, mainfile}
"""
import argparse
import base64
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import threading
import urllib.parse
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent

STATE = {
    "token": secrets.token_urlsafe(16),
    "engine": "pdflatex",
    "initial_file": None,  # updated on load/save so a browser reload restores the session
    "tmpdir": None,        # build dir for unsaved buffers
}

# One writer at a time: auto-compile and an explicit save can otherwise
# race on the same file.
WRITE_LOCK = threading.Lock()

MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json",
    ".pdf": "application/pdf",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".map": "application/json",
    ".tex": "text/plain; charset=utf-8",
}


def parse_log_errors(log):
    """Extract errors from a pdflatex log produced with -file-line-error."""
    errors = []
    for line in log.splitlines():
        m = re.match(r"^(?:\./)?(.+?\.\w+):(\d+):\s*(.*)$", line)
        if m and not line.startswith("l."):
            errors.append({"file": m.group(1), "line": int(m.group(2)), "message": m.group(3)})
        elif line.startswith("! ") and not errors:
            errors.append({"file": None, "line": None, "message": line[2:]})
        if len(errors) >= 30:
            break
    return errors


def compile_tex(source, path, mtime=None, force=False):
    """Compile `source`. If `path` is set, save there and build in its
    directory (so \\input, images, .bib etc. resolve); otherwise build in a
    session temp dir.

    `mtime` is the client's last-known modification time of the file; if the
    file on disk is newer (edited externally), refuse to overwrite unless
    `force` is set."""
    saved_mtime = None
    if path:
        p = Path(path).expanduser().resolve()
        if (mtime is not None and not force and p.exists()
                and abs(p.stat().st_mtime - mtime) > 1e-3):
            return {"conflict": True, "ok": False}
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(source, encoding="utf-8")
        saved_mtime = p.stat().st_mtime
        workdir, mainfile, jobname = p.parent, p.name, p.stem
    else:
        workdir = Path(STATE["tmpdir"])
        mainfile, jobname = "untitled.tex", "untitled"
        (workdir / mainfile).write_text(source, encoding="utf-8")

    engine = STATE["engine"]
    if engine == "latexmk":
        cmd = ["latexmk", "-pdf", "-synctex=1", "-interaction=nonstopmode", "-f", mainfile]
        max_runs = 1  # latexmk does its own rerunning
    else:
        cmd = [engine, "-synctex=1", "-interaction=nonstopmode", "-file-line-error", mainfile]
        max_runs = 3

    log = ""
    try:
        for run in range(max_runs):
            proc = subprocess.run(cmd, cwd=workdir, capture_output=True, text=True, timeout=180)
            logfile = workdir / f"{jobname}.log"
            log = logfile.read_text(errors="replace") if logfile.exists() else (proc.stdout or "")
            # NB: "undefined references" alone is NOT a rerun trigger — a
            # \ref to a missing label stays undefined forever and would make
            # every auto-compile run twice.
            if not re.search(r"Rerun to get|Rerun LaTeX", log):
                break
    except subprocess.TimeoutExpired:
        return {"ok": False, "log": log, "errors": [{"file": None, "line": None,
                "message": "Compilation timed out after 180s"}]}
    except FileNotFoundError:
        return {"ok": False, "log": "", "errors": [{"file": None, "line": None,
                "message": f"Engine not found: {engine}"}]}

    result = {
        "dir": str(workdir),
        "mainfile": mainfile,
        "mtime": saved_mtime,
        "log": log[-20000:],
        "errors": parse_log_errors(log),
    }

    pdf = workdir / f"{jobname}.pdf"
    result["ok"] = pdf.exists()
    if pdf.exists():
        result["pdf"] = base64.b64encode(pdf.read_bytes()).decode("ascii")
    for name, gz in ((f"{jobname}.synctex.gz", True), (f"{jobname}.synctex", False)):
        sfile = workdir / name
        if sfile.exists():
            result["synctex"] = base64.b64encode(sfile.read_bytes()).decode("ascii")
            result["gz"] = gz
            break
    return result


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass  # keep the terminal quiet

    # -- helpers ----------------------------------------------------------
    def send_json(self, obj, status=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        if status >= 400:
            self.send_header("Connection", "close")
            self.close_connection = True
        self.end_headers()
        self.wfile.write(body)

    def check_auth(self, query):
        token = self.headers.get("X-Auth-Token") or query.get("token", [None])[0]
        host = (self.headers.get("Host") or "").split(":")[0]
        if host not in ("127.0.0.1", "localhost"):
            return False
        return token == STATE["token"]

    def read_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(length) or b"{}")

    # -- routes -----------------------------------------------------------
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        query = urllib.parse.parse_qs(parsed.query)

        if parsed.path == "/api/load":
            if not self.check_auth(query):
                return self.send_json({"error": "unauthorized"}, 403)
            raw = query.get("path", [None])[0] or STATE["initial_file"]
            if not raw:
                return self.send_json({"path": None, "name": "untitled.tex", "source": ""})
            p = Path(raw).expanduser().resolve()
            if not p.is_file():
                return self.send_json({"error": f"not found: {p}"}, 404)
            STATE["initial_file"] = str(p)
            return self.send_json({"path": str(p), "name": p.name,
                                   "mtime": p.stat().st_mtime,
                                   "source": p.read_text(encoding="utf-8", errors="replace")})

        # static files
        rel = parsed.path.lstrip("/") or "index.html"
        target = (APP_DIR / rel).resolve()
        try:
            target.relative_to(APP_DIR)
        except ValueError:
            return self.send_json({"error": "forbidden"}, 403)
        if any(part.startswith(".") for part in Path(rel).parts):
            return self.send_json({"error": "forbidden"}, 403)
        if not target.is_file():
            return self.send_json({"error": "not found"}, 404)
        body = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", MIME.get(target.suffix, "application/octet-stream"))
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        query = urllib.parse.parse_qs(parsed.query)
        if not self.check_auth(query):
            return self.send_json({"error": "unauthorized"}, 403)
        try:
            body = self.read_body()
            if parsed.path == "/api/compile":
                with WRITE_LOCK:
                    result = compile_tex(body.get("source", ""), body.get("path"),
                                         body.get("mtime"), body.get("force", False))
                return self.send_json(result)
            if parsed.path == "/api/save":
                raw = body.get("path")
                if not raw:
                    return self.send_json({"error": "no path given"}, 400)
                p = Path(raw).expanduser().resolve()
                with WRITE_LOCK:
                    mtime = body.get("mtime")
                    if (mtime is not None and not body.get("force") and p.exists()
                            and abs(p.stat().st_mtime - mtime) > 1e-3):
                        return self.send_json({"conflict": True, "ok": False})
                    p.parent.mkdir(parents=True, exist_ok=True)
                    p.write_text(body.get("source", ""), encoding="utf-8")
                    STATE["initial_file"] = str(p)
                    return self.send_json({"ok": True, "path": str(p), "name": p.name,
                                           "mtime": p.stat().st_mtime})
            return self.send_json({"error": "not found"}, 404)
        except Exception as exc:  # noqa: BLE001 - report anything to the UI
            return self.send_json({"error": str(exc)}, 500)


def main():
    ap = argparse.ArgumentParser(description="LaTeX editor with SyncTeX click-sync")
    ap.add_argument("file", nargs="?", help=".tex file to open")
    ap.add_argument("--port", type=int, default=8123)
    ap.add_argument("--engine", default="pdflatex",
                    choices=["pdflatex", "xelatex", "lualatex", "latexmk"])
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()

    # MacTeX installs here; make sure it's reachable even from GUI launches.
    texbin = "/Library/TeX/texbin"
    if os.path.isdir(texbin) and texbin not in os.environ.get("PATH", ""):
        os.environ["PATH"] = texbin + os.pathsep + os.environ.get("PATH", "")

    probe = "latexmk" if args.engine == "latexmk" else args.engine
    if not shutil.which(probe):
        sys.exit(f"error: {probe} not found on PATH — is TeX installed?")

    STATE["engine"] = args.engine
    STATE["tmpdir"] = tempfile.mkdtemp(prefix="latex-editor-")

    if args.file:
        p = Path(args.file).expanduser().resolve()
        if not p.is_file():
            sys.exit(f"error: no such file: {p}")
        STATE["initial_file"] = str(p)

    port = args.port
    for _ in range(20):
        try:
            server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
            break
        except OSError:
            port += 1
    else:
        sys.exit("error: no free port found")

    url = f"http://127.0.0.1:{port}/?token={STATE['token']}"
    print(f"LaTeX editor running at {url}")
    print("Ctrl-C to stop.")
    if not args.no_browser:
        threading.Timer(0.3, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")
        shutil.rmtree(STATE["tmpdir"], ignore_errors=True)


if __name__ == "__main__":
    main()
