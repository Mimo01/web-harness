/* Static server for developing the harness, plus two dev-only helpers used by dev/codetest.html:
   /__ls and /__stat (directory listing / metadata, which a static file server cannot express) and
   /__git (runs a read-only git command so the test page can compare its own parser against real git).
   These are for development only and are not part of the app: the server is bound to 127.0.0.1, git is limited to an
   allowlist of read-only subcommands, and `?base=` lets the test page point at another checkout — which means this
   server can read any file the user can read. Run it on your own machine, not anywhere shared. */
const http = require('http'), fs = require('fs'), path = require('path'), cp = require('child_process');
const root = path.resolve(__dirname, '..');
const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.md': 'text/markdown', '.svg': 'image/svg+xml' };
const GIT_OK = new Set(['rev-parse', 'log', 'status', 'ls-tree', 'cat-file', 'diff', 'show', 'branch', 'blame', 'ls-files', 'rev-list', 'for-each-ref', 'count-objects']);

const json = (res, code, data) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
/* every dev endpoint works inside `base` (default: this repo), so a packed fixture elsewhere can be tested too */
const baseOf = (q) => q.get('base') ? path.resolve(q.get('base')) : root;
const inside = (base, p) => { const full = path.resolve(base, '.' + path.sep + p.replace(/^[/\\]+/, '')); return full === base || full.startsWith(base + path.sep) ? full : null; };

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const q = url.searchParams;
  const p = decodeURIComponent(url.pathname);

  if (p === '/__ls' || p === '/__stat') {
    const base = baseOf(q);
    const full = inside(base, q.get('path') || '');
    if (!full) return json(res, 400, { error: 'path escapes base' });
    try {
      const st = fs.statSync(full);
      if (p === '/__stat') return json(res, 200, { kind: st.isDirectory() ? 'directory' : 'file', size: st.size, mtime: st.mtimeMs, name: path.basename(full) });
      if (!st.isDirectory()) return json(res, 400, { error: 'not a directory' });
      const entries = fs.readdirSync(full, { withFileTypes: true }).map(d => {
        const e = { name: d.name, kind: d.isDirectory() ? 'directory' : 'file' };
        if (e.kind === 'file') { try { const s = fs.statSync(path.join(full, d.name)); e.size = s.size; e.mtime = s.mtimeMs; } catch { e.size = 0; e.mtime = 0; } }
        return e;
      });
      return json(res, 200, { entries });
    } catch (e) { return json(res, 404, { error: e.message }); }
  }

  if (p === '/__read') {
    const base = baseOf(q);
    const full = inside(base, q.get('path') || '');
    if (!full) return json(res, 400, { error: 'path escapes base' });
    return fs.readFile(full, (err, data) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(data);
    });
  }

  if (p === '/__git') {
    let args; try { args = JSON.parse(q.get('args') || '[]'); } catch { return json(res, 400, { error: 'args must be a JSON array' }); }
    if (!Array.isArray(args) || !args.length || !GIT_OK.has(args[0])) return json(res, 400, { error: 'only read-only git subcommands are allowed: ' + [...GIT_OK].join(', ') });
    cp.execFile('git', args, { cwd: baseOf(q), maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      json(res, 200, { ok: !err, code: err?.code ?? 0, stdout, stderr: stderr || (err ? String(err.message) : '') });
    });
    return;
  }

  const f = path.join(root, p === '/' ? '/index.html' : p);
  fs.readFile(f, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}).listen(8765, '127.0.0.1', () => console.log('serving', root, 'on http://127.0.0.1:8765'));
