/* Text diff engine shared by the git tools, the workspace snapshot fallback and the UI.
   Patience-style: trim the common ends, split on lines that occur exactly once on both sides,
   and run Myers on the small regions in between. No dependency. */
H.diff = (() => {
  const splitLines = (t) => String(t ?? '').split('\n');
  const isBinary = (t) => typeof t === 'string' ? t.includes('\0') : true;

  /* --- Myers O(ND) on two line arrays, with a cost cap. Returns [{t:'=',|'-'|'+', lines:[…]}] --- */
  function myers(a, b) {
    const N = a.length, M = b.length, MAX = N + M;
    if (!N && !M) return [];
    if (!N) return [{ t: '+', lines: b }];
    if (!M) return [{ t: '-', lines: a }];
    if (MAX > 20000) return [{ t: '-', lines: a }, { t: '+', lines: b }];   // too big to be worth an exact script
    const V = new Int32Array(2 * MAX + 1); const trace = [];
    for (let d = 0; d <= MAX; d++) {
      trace.push(V.slice());
      for (let k = -d; k <= d; k += 2) {
        let x = (k === -d || (k !== d && V[k - 1 + MAX] < V[k + 1 + MAX])) ? V[k + 1 + MAX] : V[k - 1 + MAX] + 1;
        let y = x - k;
        while (x < N && y < M && a[x] === b[y]) { x++; y++; }
        V[k + MAX] = x;
        if (x >= N && y >= M) return backtrack(trace, a, b, d, MAX);
      }
    }
    return [{ t: '-', lines: a }, { t: '+', lines: b }];
  }
  function backtrack(trace, a, b, d, MAX) {
    const out = []; let x = a.length, y = b.length;
    const push = (t, line) => { const last = out[out.length - 1]; if (last && last.t === t) last.lines.push(line); else out.push({ t, lines: [line] }); };
    for (let dd = d; dd > 0; dd--) {
      const V = trace[dd]; const k = x - y;
      const down = (k === -dd || (k !== dd && V[k - 1 + MAX] < V[k + 1 + MAX]));
      const kPrev = down ? k + 1 : k - 1;
      const xStart = V[kPrev + MAX], yStart = xStart - kPrev;
      const xMid = down ? xStart : xStart + 1, yMid = xMid - k;
      while (x > xMid) { push('=', a[--x]); y--; }
      if (down) push('+', b[--y]); else push('-', a[--x]);
    }
    while (x > 0) { push('=', a[--x]); y--; }
    for (const p of out) p.lines.reverse();
    return out.reverse();
  }

  /* --- unique common lines become anchors, so big files diff sensibly and cheaply --- */
  function anchors(a, b) {
    const count = (arr) => { const m = new Map(); for (let i = 0; i < arr.length; i++) { const e = m.get(arr[i]); if (e) e.n++; else m.set(arr[i], { n: 1, i }); } return m; };
    const ca = count(a), cb = count(b);
    const pairs = [];
    for (const [line, ea] of ca) { if (ea.n !== 1) continue; const eb = cb.get(line); if (eb && eb.n === 1) pairs.push([ea.i, eb.i]); }
    pairs.sort((p, q) => p[0] - q[0]);
    // longest increasing subsequence over the b-positions
    const tails = [], from = new Array(pairs.length).fill(-1), idx = [];
    for (let i = 0; i < pairs.length; i++) {
      let lo = 0, hi = tails.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (pairs[idx[mid]][1] < pairs[i][1]) lo = mid + 1; else hi = mid; }
      from[i] = lo > 0 ? idx[lo - 1] : -1;
      idx[lo] = i; if (lo === tails.length) tails.push(0);
    }
    const out = [];
    for (let i = tails.length ? idx[tails.length - 1] : -1; i >= 0; i = from[i]) out.push(pairs[i]);
    return out.reverse();
  }

  function diffRegion(a, b, depth = 0) {
    if (!a.length || !b.length || depth > 6) return myers(a, b);
    if (a.length + b.length < 400) return myers(a, b);
    const an = anchors(a, b);
    if (!an.length) return myers(a, b);
    const out = []; let ai = 0, bi = 0;
    for (const [x, y] of an) {
      if (x > ai || y > bi) out.push(...diffRegion(a.slice(ai, x), b.slice(bi, y), depth + 1));
      const last = out[out.length - 1];
      if (last && last.t === '=') last.lines.push(a[x]); else out.push({ t: '=', lines: [a[x]] });
      ai = x + 1; bi = y + 1;
    }
    if (ai < a.length || bi < b.length) out.push(...diffRegion(a.slice(ai), b.slice(bi), depth + 1));
    return out;
  }

  /** Line-level edit script: [{ t: '=' | '-' | '+', lines: [...] }] */
  function lines(aText, bText) {
    const a = splitLines(aText), b = splitLines(bText);
    let pre = 0; while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
    let suf = 0; while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
    const mid = diffRegion(a.slice(pre, a.length - suf), b.slice(pre, b.length - suf));
    const out = [];
    if (pre) out.push({ t: '=', lines: a.slice(0, pre) });
    for (const p of mid) { const last = out[out.length - 1]; if (last && last.t === p.t) last.lines.push(...p.lines); else out.push(p); }
    if (suf) { const last = out[out.length - 1]; const tail = a.slice(a.length - suf); if (last && last.t === '=') last.lines.push(...tail); else out.push({ t: '=', lines: tail }); }
    return out;
  }

  /** { added, removed } without building a patch */
  function stat(aText, bText) {
    let added = 0, removed = 0;
    for (const p of lines(aText, bText)) { if (p.t === '+') added += p.lines.length; else if (p.t === '-') removed += p.lines.length; }
    return { added, removed };
  }

  /** Unified diff text. a/b are strings (null = file absent). Returns '' when there is no change. */
  function unified(aText, bText, { path = 'file', oldPath = null, context = 3, oldLabel = null, newLabel = null } = {}) {
    const added = aText == null, deleted = bText == null;
    if (added && deleted) return '';
    if (aText === bText) return '';
    if (isBinary(aText) || isBinary(bText)) return `--- ${oldLabel ?? (added ? '/dev/null' : 'a/' + (oldPath || path))}\n+++ ${newLabel ?? (deleted ? '/dev/null' : 'b/' + path)}\nBinary files differ\n`;
    const aFull = aText ?? '', bFull = bText ?? '';
    // a trailing newline produces an empty last element: drop it and remember, like git does
    const aNoEol = aFull !== '' && !aFull.endsWith('\n'), bNoEol = bFull !== '' && !bFull.endsWith('\n');
    const a = aFull === '' ? [] : splitLines(aNoEol ? aFull : aFull.slice(0, -1));
    const b = bFull === '' ? [] : splitLines(bNoEol ? bFull : bFull.slice(0, -1));
    const script = lines(a.join('\n'), b.join('\n'));
    if (!a.length && !b.length) return '';
    // flatten to per-line ops with line numbers
    const ops = []; let ai = 0, bi = 0;
    for (const p of script) {
      if (!(p.lines.length === 1 && p.lines[0] === '' && !a.length && !b.length)) {
        for (const l of p.lines) {
          if (p.t === '=') ops.push({ t: ' ', a: ++ai, b: ++bi, text: l });
          else if (p.t === '-') ops.push({ t: '-', a: ++ai, b: null, text: l });
          else ops.push({ t: '+', a: null, b: ++bi, text: l });
        }
      }
    }
    const changed = ops.map((o, i) => o.t !== ' ' ? i : -1).filter(i => i >= 0);
    if (!changed.length) return '';
    // group changed lines into hunks with `context` lines around them
    const hunks = []; let start = Math.max(0, changed[0] - context), end = Math.min(ops.length, changed[0] + context + 1);
    for (const i of changed.slice(1)) {
      if (i - context <= end) end = Math.min(ops.length, i + context + 1);
      else { hunks.push([start, end]); start = Math.max(0, i - context); end = Math.min(ops.length, i + context + 1); }
    }
    hunks.push([start, end]);
    let out = `--- ${oldLabel ?? (added ? '/dev/null' : 'a/' + (oldPath || path))}\n+++ ${newLabel ?? (deleted ? '/dev/null' : 'b/' + path)}\n`;
    for (const [s, e] of hunks) {
      const slice = ops.slice(s, e);
      const aLines = slice.filter(o => o.t !== '+'), bLines = slice.filter(o => o.t !== '-');
      const aStart = aLines.length ? aLines[0].a : 0, bStart = bLines.length ? bLines[0].b : 0;
      out += `@@ -${aStart},${aLines.length} +${bStart},${bLines.length} @@\n`;
      for (const o of slice) {
        out += o.t + o.text + '\n';
        if (o.t !== '+' && aNoEol && o.a === a.length) out += '\\ No newline at end of file\n';
        if (o.t === '+' && bNoEol && o.b === b.length) out += '\\ No newline at end of file\n';
      }
    }
    return out;
  }

  return { lines, unified, stat, isBinary, splitLines };
})();
