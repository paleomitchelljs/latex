/* SyncTeX parser + bidirectional queries.
 *
 * Coordinates: SyncTeX records positions in scaled points (sp) with the
 * origin at the TOP-LEFT of the page, y increasing downward, and box
 * anchors on the baseline. Everything is converted to big points (bp,
 * i.e. PDF points) at parse time, keeping the top-left origin.
 *
 * Works in the browser (window.SyncTeX) and in Node (module.exports).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SyncTeX = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SP_PER_BP = 65781.76; // sp per PDF point (accounts for pt vs bp)

  /* Parse the uncompressed text of a .synctex file. */
  function parse(text) {
    var inputs = {};
    var unit = 1, mag = 1000, xoff = 0, yoff = 0;
    var lines = text.split('\n');
    var i = 0;

    for (; i < lines.length; i++) {
      var L = lines[i];
      if (L.startsWith('Input:')) {
        var m = L.match(/^Input:(\d+):(.*)$/);
        if (m) inputs[m[1]] = m[2];
      } else if (L.startsWith('Unit:')) unit = parseFloat(L.slice(5)) || 1;
      else if (L.startsWith('Magnification:')) mag = parseFloat(L.slice(14)) || 1000;
      else if (L.startsWith('X Offset:')) xoff = parseFloat(L.slice(9)) || 0;
      else if (L.startsWith('Y Offset:')) yoff = parseFloat(L.slice(9)) || 0;
      else if (L.startsWith('Content:')) { i++; break; }
    }

    var f = (unit * (mag / 1000)) / SP_PER_BP; // sp -> bp

    var pages = {};       // pageNo -> { hboxes: [...] }
    var curPage = null;
    var hstack = [];      // open hboxes (innermost last)

    var boxRe  = /^([\[(])(\d+),(\d+)(?:,-?\d+)?:(-?\d+),(-?\d+):(-?\d+),(-?\d+),(-?\d+)$/;
    var voidRe = /^([vh])(\d+),(\d+)(?:,-?\d+)?:(-?\d+),(-?\d+):(-?\d+),(-?\d+),(-?\d+)$/;
    var kernRe = /^k(\d+),(\d+)(?:,-?\d+)?:(-?\d+),(-?\d+):(-?\d+)$/;
    var nodeRe = /^([xg$])(\d+),(\d+)(?:,-?\d+)?:(-?\d+),(-?\d+)$/;

    function mkBox(m) {
      var h = parseInt(m[4], 10) + xoff, v = parseInt(m[5], 10) + yoff;
      var W = parseInt(m[6], 10), H = parseInt(m[7], 10), D = parseInt(m[8], 10);
      return {
        tag: m[2], line: parseInt(m[3], 10),
        left: h * f, top: (v - H) * f,
        width: Math.max(W * f, 0), height: Math.max((H + D) * f, 0),
        nodes: []
      };
    }

    for (; i < lines.length; i++) {
      var s = lines[i];
      if (!s) continue;
      var c = s.charCodeAt(0);

      if (c === 123 /*{*/) { curPage = parseInt(s.slice(1), 10); if (!pages[curPage]) pages[curPage] = { hboxes: [] }; hstack = []; continue; }
      if (c === 125 /*}*/) { curPage = null; hstack = []; continue; }
      if (curPage == null) {
        if (s.startsWith('Input:')) { var mi = s.match(/^Input:(\d+):(.*)$/); if (mi) inputs[mi[1]] = mi[2]; }
        if (s.startsWith('Postamble:')) break;
        continue;
      }
      if (c === 33 /*!*/) continue;
      if (c === 93 /*]*/) continue;
      if (c === 41 /*)*/) { hstack.pop(); continue; }

      var m;
      if (c === 40 /*(*/ || c === 91 /*[*/) {
        m = s.match(boxRe);
        if (m) {
          if (m[1] === '(') { var b = mkBox(m); pages[curPage].hboxes.push(b); hstack.push(b); }
          // vbox begins are containers only; their children carry the detail
        }
        continue;
      }
      if (c === 118 /*v*/ || c === 104 /*h*/) {
        m = s.match(voidRe);
        if (m && m[1] === 'h') pages[curPage].hboxes.push(mkBox(m));
        continue;
      }
      var node = null;
      if (c === 107 /*k*/) { m = s.match(kernRe); if (m) node = { tag: m[1], line: parseInt(m[2], 10), h: parseInt(m[3], 10) * f }; }
      else { m = s.match(nodeRe); if (m) node = { tag: m[2], line: parseInt(m[3], 10), h: parseInt(m[4], 10) * f }; }
      if (node && hstack.length) hstack[hstack.length - 1].nodes.push(node);
    }

    return { inputs: inputs, pages: pages };
  }

  /* PDF position -> source location.
   * (x, y) in bp with top-left origin on `pageNo` (1-based).
   * Returns { tag, line, box } or null.
   */
  function forward(data, pageNo, x, y) {
    var pg = data.pages[pageNo];
    if (!pg || !pg.hboxes.length) return null;

    var best = null, bestArea = Infinity;
    var PAD = 2; // bp of forgiveness around thin boxes
    for (var i = 0; i < pg.hboxes.length; i++) {
      var b = pg.hboxes[i];
      if (x >= b.left - PAD && x <= b.left + b.width + PAD &&
          y >= b.top - PAD && y <= b.top + b.height + PAD) {
        var area = Math.max(b.width, 1) * Math.max(b.height, 1);
        if (area < bestArea) { bestArea = area; best = b; }
      }
    }
    if (!best) {
      var bestD = Infinity;
      for (var j = 0; j < pg.hboxes.length; j++) {
        var bb = pg.hboxes[j];
        var dx = x < bb.left ? bb.left - x : (x > bb.left + bb.width ? x - bb.left - bb.width : 0);
        var dy = y < bb.top ? bb.top - y : (y > bb.top + bb.height ? y - bb.top - bb.height : 0);
        var d = dx * dx + 4 * dy * dy; // weight vertical distance: lines are horizontal
        if (d < bestD) { bestD = d; best = bb; }
      }
      if (!best || bestD > 200 * 200) return null;
    }

    // Refine with the nearest content node: an output line's hbox can span
    // several source lines, and nodes carry per-word line numbers. The
    // first/last nodes are usually boundary glue stamped with the line of
    // the paragraph's end, so penalize them.
    var tag = best.tag, line = best.line;
    var nd = Infinity;
    var nn = best.nodes.length;
    for (var k = 0; k < nn; k++) {
      var n = best.nodes[k];
      var penalty = (nn >= 3 && (k === 0 || k === nn - 1)) ? 6 : 0;
      var d2 = Math.abs(n.h - x) + penalty;
      if (d2 < nd) { nd = d2; tag = n.tag; line = n.line; }
    }
    return { tag: tag, line: line, box: best };
  }

  /* Source location -> PDF regions.
   * Returns { page, rects: [{left,top,width,height}] } (bp, top-left origin)
   * or null. Searches nearby lines (blank/comment lines produce no boxes).
   */
  function reverse(data, tag, line) {
    for (var delta = 0; delta <= 10; delta++) {
      var tries = delta === 0 ? [line] : [line + delta, line - delta];
      for (var t = 0; t < tries.length; t++) {
        var hit = reverseExact(data, tag, tries[t]);
        if (hit) return hit;
      }
    }
    return null;
  }

  function reverseExact(data, tag, line) {
    var pageNos = Object.keys(data.pages).map(Number).sort(function (a, b) { return a - b; });
    for (var p = 0; p < pageNos.length; p++) {
      var pg = data.pages[pageNos[p]];
      var rects = [];
      for (var i = 0; i < pg.hboxes.length; i++) {
        var b = pg.hboxes[i];
        // SyncTeX emits degenerate zero-size boxes (headers, alignment
        // marks); they carry misleading positions, so skip them.
        if (b.width < 1 || b.height < 0.5) continue;
        if (b.tag === tag && b.line === line) {
          rects.push({ left: b.left, top: b.top, width: b.width, height: b.height });
          continue;
        }
        var lo = Infinity, hi = -Infinity;
        for (var k = 0; k < b.nodes.length; k++) {
          var n = b.nodes[k];
          if (n.tag === tag && n.line === line) { lo = Math.min(lo, n.h); hi = Math.max(hi, n.h); }
        }
        if (lo !== Infinity) {
          rects.push({ left: lo, top: b.top, width: Math.max(hi - lo, 8), height: b.height });
        }
      }
      if (rects.length) return { page: pageNos[p], rects: rects };
    }
    return null;
  }

  return { parse: parse, forward: forward, reverse: reverse };
});
