/* Code execution: sandboxed JavaScript (Web Worker) and Python (Pyodide via CDN) */
H.runtime = (() => {
  /* ---- JavaScript in a Worker ---- */
  /* A Worker made from a blob: URL runs on the harness's own origin, so "sandbox" here only means what is taken
     away from it before the user code runs. Two preludes do that, sharing these two helpers: kill() replaces a
     constructor with one that throws; hide() replaces an object-valued global with a getter that throws, so
     reaching for it at all is the error rather than calling a method on a function. */
  const KILL = `
          const dead = (n, why) => function () { throw new Error(n + ' is not available: ' + why); };
          const kill = (o, n, why) => { try { Object.defineProperty(o, n, { value: dead(n, why), writable: false, configurable: false }); } catch { try { o[n] = dead(n, why); } catch { } } };
          const hide = (o, n, why) => { try { Object.defineProperty(o, n, { get() { throw new Error(n + ' is not available: ' + why); }, configurable: false }); } catch { try { o[n] = undefined; } catch { } } };`;
  /* ALWAYS. localStorage is not exposed to workers (which is where the API key and plugin credentials live), but
     IndexedDB is — and that is where every chat, the model's memories, the unsent draft and the folder registry
     are kept. A registry row holds a live FileSystemDirectoryHandle, which is structured-cloneable and works from
     a worker: reachable from here, the workspace would be readable and writable around H.fs and the whole
     permission layer. Since calculate and json_query are "safe" tools that take an expression straight from the
     model, and plugin manifests run transform/prepare/pathFn the same way, this has to go regardless of what the
     caller asked for. BroadcastChannel and the lock/storage managers are shut for the same reason: they are
     same-origin channels out of the sandbox. */
  const NO_STORAGE = `
        (() => {
          ${KILL}
          const why = 'this sandbox has no access to the harness\\'s storage';
          for (const n of ['indexedDB', 'caches']) hide(self, n, why);
          kill(self, 'BroadcastChannel', why);
          if (self.navigator) for (const n of ['locks', 'storage']) hide(self.navigator, n, why);
        })();`;
  /* network:false removes every outbound channel a Worker has (fetch, XHR, WebSocket, EventSource, importScripts, nested
     workers, WebTransport, sendBeacon) before the user code runs, so an expression evaluated as a "safe" tool cannot exfiltrate. */
  const NO_NETWORK = `
        (() => {
          ${KILL}
          const why = 'this sandbox has no network access';
          for (const n of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts', 'Worker', 'SharedWorker', 'WebTransport', 'RTCPeerConnection']) kill(self, n, why);
          if (self.navigator) kill(self.navigator, 'sendBeacon', why);
        })();`;
  const ABORTED = { error: 'Cancelled by the user (Stop).', logs: [] };
  /* `files` (path -> text) is what run_javascript loaded from the folder or the chat's attachments, read by the
     harness and handed over directly so the data never has to pass through the model; saveFile() collects what
     the code wants written back, and the caller decides where it goes. */
  function runJS(code, { timeout = 15000, input, files, network = true, signal } = {}) {
    if (signal?.aborted) return Promise.resolve({ ...ABORTED });
    return new Promise((resolve) => {
      const src = `${NO_STORAGE}${network ? '' : NO_NETWORK}
        const __logs = [];
        const __fmt = (a) => a.map(x => { try { return typeof x === 'string' ? x : JSON.stringify(x, null, 1); } catch { return String(x); } }).join(' ');
        for (const k of ['log','info','warn','error','debug']) console[k] = (...a) => __logs.push((k==='log'?'':'['+k+'] ') + __fmt(a));
        self.onmessage = async (e) => {
          const input = e.data.input, files = e.data.files || {}, __saved = {};
          const saveFile = (path, content) => { __saved[String(path)] = typeof content === 'string' ? content : JSON.stringify(content, null, 2); };
          let result, error;
          try {
            const fn = new (Object.getPrototypeOf(async function(){}).constructor)('input', 'files', 'saveFile', e.data.code);
            result = await fn(input, files, saveFile);
          } catch (err) { error = (err && err.stack) || String(err); }
          let out; try { out = result === undefined ? undefined : JSON.parse(JSON.stringify(result)); } catch { out = String(result); }
          self.postMessage({ logs: __logs, result: out, error, saved: __saved });
        };`;
      const blob = new Blob([src], { type: 'application/javascript' });
      const url = URL.createObjectURL(blob);
      let w; try { w = new Worker(url); } catch (e) { URL.revokeObjectURL(url); return resolve({ error: 'Could not start a Web Worker: ' + e.message, logs: [] }); }
      const onAbort = () => finish({ ...ABORTED });
      const finish = (v) => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); w.terminate(); URL.revokeObjectURL(url); resolve(v); };
      signal?.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => finish({ error: `Timed out after ${timeout} ms. The code ran too long (infinite loop or slow network?); increase timeoutMs or simplify.`, logs: [] }), timeout);
      w.onmessage = (e) => finish(e.data);
      w.onerror = (e) => finish({ error: (e.message || 'Worker error') + ' (syntax error in the code? check the line reported)', logs: [] });
      w.postMessage({ code, input, files });
    });
  }

  /* ---- Python via Pyodide, inside a dedicated Worker ----
     The interpreter is loaded once and kept alive between runs. Because it runs off the main thread, a timeout can
     terminate it (an infinite loop cannot freeze the page); the next run then reloads the runtime.
     This worker deliberately keeps the globals NO_STORAGE takes away above: Pyodide is fetched and loaded here,
     so it needs the network either way, and run_python is a 'write' tool that asks before it runs. Taking away
     IndexedDB would buy nothing a tool with fetch cannot already do, at the cost of breaking package loading. ---- */
  let pyWorker = null, pyReady = false, pyLoading = null, pyId = 0;
  const pyPending = new Map();   // id -> { resolve, timer, onStatus }
  function pyWorkerSource() {
    return `
      let py = null;
      const post = (m) => self.postMessage(m);
      async function ensure(url, indexURL, id) {
        if (py) return py;
        post({ type: 'status', id, text: 'Loading Pyodide runtime (~10 MB, first time only)…' });
        importScripts(url);
        py = await self.loadPyodide({ indexURL });
        post({ type: 'status', id, text: 'Pyodide ready' });
        return py;
      }
      self.onmessage = async (e) => {
        const m = e.data;
        if (m.type !== 'run') return;
        let stdout = '', stderr = '', result, error;
        try {
          const p = await ensure(m.url, m.indexURL, m.id);
          if (m.packages && m.packages.length) {
            post({ type: 'status', id: m.id, text: 'Installing packages: ' + m.packages.join(', ') });
            try { await p.loadPackage(m.packages); }
            catch { await p.loadPackage('micropip'); const mp = p.pyimport('micropip'); await mp.install(m.packages); }
          }
          // mkdirTree walks from the root whatever it is given, so a relative folder has to be made absolute first
          const parentOf = (name) => { const dir = name.split('/').slice(0, -1).join('/'); if (dir) p.FS.mkdirTree(dir.startsWith('/') ? dir : p.FS.cwd() + '/' + dir); };
          for (const [name, content] of Object.entries(m.files || {})) { parentOf(name); p.FS.writeFile(name, content); }
          // the file system outlives the run: an output left by an earlier run must not pass for this one's
          for (const name of m.outputs || []) { parentOf(name); try { p.FS.unlink(name); } catch { } }   // parentOf: so open('out/x.csv', 'w') just works
          p.setStdout({ batched: (s) => { stdout += s + '\\n'; } });
          p.setStderr({ batched: (s) => { stderr += s + '\\n'; } });
          await p.loadPackagesFromImports(m.code);
          result = await p.runPythonAsync(m.code);
          if (result && typeof result.toJs === 'function') { try { result = result.toJs({ dict_converter: Object.fromEntries }); } catch { result = String(result); } }
          if (result !== undefined && typeof result === 'object') { try { result = JSON.parse(JSON.stringify(result)); } catch { result = String(result); } }
        } catch (err) {
          error = String(err && (err.message || (err.errno != null && 'File system error (errno ' + err.errno + ') while preparing files')) || err);
          const mm = error.match(/(\\w+Error: .*)$/m); if (mm) error = mm[1] + ' (see stderr/traceback; fix the code and run again)';
        }
        const saved = {}, missing = [];
        if (py && !error) for (const name of m.outputs || []) { try { saved[name] = py.FS.readFile(name); } catch { missing.push(name); } }
        post({ type: 'result', id: m.id, stdout: stdout.trimEnd(), stderr: stderr.trimEnd(), result, error, saved, missing });
      };`;
  }
  function pyStart() {
    const url = URL.createObjectURL(new Blob([pyWorkerSource()], { type: 'application/javascript' }));
    pyWorker = new Worker(url); URL.revokeObjectURL(url); pyReady = false;
    pyWorker.onmessage = (e) => {
      const m = e.data; const p = pyPending.get(m.id);
      if (m.type === 'status') { if (m.text === 'Pyodide ready') pyReady = true; p?.onStatus?.(m.text); return; }
      if (m.type === 'result' && p) { clearTimeout(p.timer); pyPending.delete(m.id); p.resolve({ stdout: m.stdout, stderr: m.stderr, result: m.result, error: m.error, saved: m.saved, missing: m.missing }); }
    };
    pyWorker.onerror = (e) => { for (const [id, p] of pyPending) { clearTimeout(p.timer); pyPending.delete(id); p.resolve({ error: 'Python worker error: ' + (e.message || 'unknown') + '. If Pyodide failed to load, check the network / Pyodide URL in Settings > Web access.', stdout: '', stderr: '' }); } pyWorker = null; pyReady = false; };
  }
  /* Killing the runtime ends every run it was carrying, not only the one that asked for it. `owner` is the run
     whose timeout or Stop this was, so the others are told what actually happened to them instead of being
     handed "your code timed out" for someone else's infinite loop. */
  function pyKill(reason, owner) {
    if (!pyWorker) return;
    try { pyWorker.terminate(); } catch { }
    pyWorker = null; pyReady = false;
    const collateral = 'The Python runtime was restarted while this was running (another run was stopped or timed out), so this call produced no result. Run it again.';
    for (const [id, p] of pyPending) { clearTimeout(p.timer); pyPending.delete(id); p.resolve({ error: owner == null || id === owner ? reason : collateral, stdout: '', stderr: '' }); }
  }
  /* `files` (path -> text or bytes) are placed in the working directory before the code runs, folders included;
     `outputs` are read back from it afterwards and returned in `saved`, for the caller to write wherever they belong. */
  function runPython(code, { packages = [], files = {}, outputs = [], timeout = 60000, onStatus, signal } = {}) {
    if (signal?.aborted) return Promise.resolve({ error: 'Cancelled by the user (Stop).', stdout: '', stderr: '' });
    if (!H.settings.get('allowPyodideCdn')) return Promise.resolve({ error: 'Python is disabled: downloading the Pyodide runtime is turned off in Settings > Web access. Ask the user to enable it, or use run_javascript instead.', stdout: '', stderr: '' });
    /* the setting is a free-text field, and an old export restored without the key leaves it undefined —
       either way the runtime has nowhere to come from, which is a result, not a TypeError out of the tool */
    const url = H.settings.get('pyodideUrl') || H.settings.defaults.pyodideUrl;
    if (!url) return Promise.resolve({ error: 'Python cannot start: no Pyodide URL is configured (Settings > Web access > Advanced: Python runtime). Ask the user to set one, or use run_javascript instead.', stdout: '', stderr: '' });
    if (!pyWorker) pyStart();
    const id = ++pyId;
    const indexURL = url.replace(/pyodide\.js$/, '');
    // first run includes the runtime download; give it extra time
    const budget = timeout + (pyReady ? 0 : 120000);
    return new Promise((resolve) => {
      const timer = setTimeout(() => pyKill(`Python timed out after ${Math.round(timeout / 1000)} s and was terminated (infinite loop or very slow code?). The runtime will reload on the next run. Increase timeoutMs or simplify the code.`, id), budget);
      const onAbort = () => { if (pyPending.has(id)) pyKill('Cancelled by the user (Stop). The Python runtime was terminated and will reload on the next run.', id); };
      signal?.addEventListener('abort', onAbort, { once: true });
      pyPending.set(id, { resolve: (v) => { signal?.removeEventListener('abort', onAbort); resolve(v); }, timer, onStatus });
      try { pyWorker.postMessage({ type: 'run', id, code, packages, files, outputs, url, indexURL }); }
      catch (e) { clearTimeout(timer); pyPending.delete(id); resolve({ error: 'Could not start Python: ' + e.message, stdout: '', stderr: '' }); }
    });
  }
  /* ---- HTML preview in a sandboxed iframe / new tab ---- */
  /* A srcdoc iframe inherits the page CSP (connect-src *), so model-authored HTML gets its own, stricter policy injected:
     no fetch/XHR/WebSocket, no form posts, no frames, images/media only inline; scripts and styles inline or from the
     two CDNs the app already trusts. */
  /* Script hosts: the general-purpose CDNs models reach for (cdnjs, jsdelivr, unpkg, esm.sh — which pulls its own
     sub-modules from itself), plus Tailwind's play CDN and jQuery's. A script URL can carry data in its query, but
     only to a CDN's logs, which nobody writing a page can read; the ways out that matter (fetch, forms, frames,
     remote images, popups) stay shut. data: and blob: are for modules the bundler inlines and workers a page
     makes of its own code — both no more than an inline script can already do. */
  const CDNS = 'https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com https://esm.sh';
  const PREVIEW_CSP = `default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' data: blob: ${CDNS} https://cdn.tailwindcss.com https://code.jquery.com; worker-src blob: data:; style-src 'unsafe-inline' https://fonts.googleapis.com ${CDNS}; font-src data: https://fonts.gstatic.com ${CDNS}; img-src data: blob:; media-src data: blob:; connect-src 'none'; form-action 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'`;
  /* Where the policy goes. Matching /<head[^>]*>/ also matches a "<head>" written inside a comment, and a meta
     placed there is not a policy at all — `<!-- <head> -->` was enough to ship the preview without one. So the
     source is walked tag by tag, stepping over comments, and the first real <head>, <html> or doctype decides.
     (The frame also inherits preview.html's own CSP, which is what actually enforces; this is the copy that
     travels with the document, e.g. into the downloaded file's sibling contexts.) */
  function cspAnchor(src) {
    let i = 0, afterDoctype = -1;
    while (i < src.length) {
      const lt = src.indexOf('<', i);
      if (lt < 0) break;
      if (src.startsWith('<!--', lt)) { const end = src.indexOf('-->', lt + 4); if (end < 0) break; i = end + 3; continue; }
      const m = /^<(!doctype|\/?[a-zA-Z][^\s>/]*)[^>]*>/.exec(src.slice(lt));
      if (!m) { i = lt + 1; continue; }
      const end = lt + m[0].length, name = m[1].toLowerCase();
      if (name === 'head') return { at: end, wrap: false };
      if (name === 'html') return { at: end, wrap: true };
      if (name === '!doctype') { afterDoctype = end; i = end; continue; }
      break;   // real content before any <html>/<head>
    }
    return afterDoctype >= 0 ? { at: afterDoctype, wrap: false } : null;
  }
  /* "Save as PDF" is the browser's own print-to-PDF, which needs the *frame* to call print(): the preview frame is
     a sandboxed, opaque origin, so the harness cannot reach its print() (not on the cross-origin allowlist), and
     printing the host page instead would clip the fixed-height frame to a single page. So the preview copy of the
     document carries this listener. It answers its embedder and nothing else, and it never travels with the file
     the Download button saves — that is `raw`, the HTML as the model wrote it. */
  /* Printing a page is not a screenshot of it, and three differences account for almost all of the "but it looked
     like this on screen": the browser drops every background colour unless the user finds the "Background graphics"
     checkbox; the page is laid out again at paper width, so a design wider than the sheet reflows or is cut; and
     boxes are sliced wherever a page happens to end. The agent answers those before it calls print() —
     print-color-adjust keeps the colours the page asked for, `zoom` fits a wide layout to the sheet by scaling the
     layout itself (so it still paginates, unlike a transform), and the break rules keep cards, images, tables and
     listings whole. It changes nothing on screen: the stylesheet is entirely inside @media print, the zoom is set
     for the duration of the print and undone afterwards, and the model's own @media print rules come first, so a
     page that has thought about printing still wins.
     FIT is the printable width of the narrower common sheet (A4, 210mm) inside the 10mm margins set below, in CSS
     pixels at 96dpi. Only ever scales down. */
  const PRINT_AGENT = `<script>(function(){var FIT=714,PRINT_CSS='@media print{'
+'@page{margin:10mm}'
+'html,body{height:auto!important;min-height:0!important;overflow:visible!important}'
+'*{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important}'
+'pre,table,figure,img,svg,blockquote,tr,li,canvas{break-inside:avoid;page-break-inside:avoid}'
+'h1,h2,h3,h4{break-after:avoid;page-break-after:avoid}'
+'}';
var style=null,prepared=false;
/* guarded: print() fires beforeprint too, and measuring a second time — with the zoom already applied —
   would scale the page again */
function before(){if(prepared)return;prepared=true;
if(!style){style=document.createElement('style');style.textContent=PRINT_CSS;(document.head||document.documentElement).appendChild(style);}
var d=document.documentElement,b=document.body,w=Math.max(d.scrollWidth,b?b.scrollWidth:0,d.getBoundingClientRect().width);
if(w>FIT)d.style.zoom=FIT/w;}
function after(){if(!prepared)return;prepared=false;document.documentElement.style.zoom='';}
addEventListener('beforeprint',before);addEventListener('afterprint',after);
addEventListener('message',function(e){if(e.source!==parent||!e.data||e.data.type!=='print')return;before();print();after();});})();<\/script>`;
  /* Runs first in every preview, before any of the page's own scripts. Two jobs.
     1. The frame is sandboxed without allow-same-origin, so it has no storage: touching localStorage,
        sessionStorage or document.cookie throws a SecurityError, and a page that reads its saved state on load
        (most generated apps do) dies before it draws anything. In-memory stand-ins keep it running; nothing
        persists, which is what a preview should do anyway.
     2. A page that fails in the preview fails silently, and the model, which cannot see the panel, would report
        success. Script errors, rejected promises, console.error, resources the policy blocked and elements that
        failed to load are collected and, once the page has settled, sent to the host page, which passes them on
        to the harness — and through render_html/run_file, back to the model. Written as a real function and
        serialised, so it needs no escaping. */
  function previewAgent(id) {
    const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(String(k)) ? m.get(String(k)) : null), setItem: (k, v) => { m.set(String(k), String(v)); }, removeItem: (k) => { m.delete(String(k)); }, clear: () => m.clear(), key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; } }; };
    for (const n of ['localStorage', 'sessionStorage']) { try { window[n].length; } catch { try { Object.defineProperty(window, n, { value: mem(), configurable: true }); } catch { } } }
    try { document.cookie; } catch { let jar = ''; try { Object.defineProperty(document, 'cookie', { get: () => jar, set: (v) => { const kv = String(v).split(';')[0]; jar = jar ? jar + '; ' + kv : kv; }, configurable: true }); } catch { } }
    const issues = [], seen = new Set();
    const add = (kind, text) => { text = String(text).slice(0, 400); const k = kind + text; if (seen.has(k) || issues.length >= 25) return; seen.add(k); issues.push({ kind, text }); };
    addEventListener('error', (e) => {
      const t = e.target;
      if (t && t !== window && t.tagName) add('load-failed', `<${t.tagName.toLowerCase()}> ${t.src || t.href || ''}`);
      else add('error', `${e.message}${e.lineno ? ` (line ${e.lineno}${e.colno ? ':' + e.colno : ''})` : ''}`);
    }, true);
    addEventListener('unhandledrejection', (e) => add('unhandled-rejection', (e.reason && (e.reason.stack || e.reason.message)) || e.reason));
    document.addEventListener('securitypolicyviolation', (e) => add('blocked', `${e.effectiveDirective || e.violatedDirective}: ${e.blockedURI || '(inline)'}`));
    const ce = console.error; console.error = function (...a) { add('console.error', a.map((x) => (x && x.stack) || (typeof x === 'object' ? (() => { try { return JSON.stringify(x); } catch { return String(x); } })() : String(x))).join(' ')); return ce.apply(this, a); };
    const report = () => {
      const b = document.body;
      parent.postMessage({ type: 'preview-report', id, report: { issues, title: document.title, textChars: b ? b.innerText.trim().length : 0, elements: b ? b.getElementsByTagName('*').length : 0, canvases: document.getElementsByTagName('canvas').length } }, '*');
    };
    addEventListener('load', () => setTimeout(report, 1200));
  }
  /* `id` travels inside the page, so a report always names the preview it came from — even one that arrives
     after the next preview has already replaced it in the same frame */
  function hardenHTML(html, id = null) {
    const head = `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}"><script>(${previewAgent.toString()})(${JSON.stringify(id)});<\/script>` + PRINT_AGENT;
    const src = String(html || '');
    const a = cspAnchor(src);
    if (!a) return head + src;
    return src.slice(0, a.at) + (a.wrap ? '<head>' + head + '</head>' : head) + src.slice(a.at);
  }
  /* A generated PDF goes to the same panel as rendered HTML, so "here is what I made" looks the same whichever
     kind of document it is. The bytes travel as they are; the panel draws them with pdf.js. */
  function previewPDF(bytes, { title = 'Document', filename = 'document.pdf' } = {}) {
    H.bus.emit('preview', { kind: 'pdf', title, bytes, filename });
    return 'preview';
  }
  /* Shows the page and resolves with what it reported once it settled (see previewAgent), or with null when no
     report came — a page still loading something slow, or one replaced by the next preview before it finished. */
  let previewSeq = 0;
  function previewHTML(html, { title = 'Preview', wait = 6000 } = {}) {
    const id = ++previewSeq;
    const done = new Promise((resolve) => {
      const off = H.bus.on('preview-report', (rid, report) => { if (rid !== id) return; clearTimeout(t); off?.(); resolve(report); });
      const t = setTimeout(() => { off?.(); resolve(null); }, wait);
    });
    H.bus.emit('preview', { title, html: hardenHTML(html, id), raw: String(html || '') });   // raw: what the model wrote, for Download   // sandboxed srcdoc iframe (unique origin) with an injected CSP; never a same-origin blob URL
    return done;
  }

  /* ---- Building a page from the folder ----
     The preview is a srcdoc document in a sandbox: it has no address of its own, so `<script src="app.js">`,
     `style.css`, `logo.png` or `fetch('data.json')` point at nothing, and a page split into files — the usual way
     to write one — previews as a broken shell. bundleHTML() reads what the page refers to from the open folder
     and builds it in: scripts and styles inline, ES modules (and what they import) as data: URLs, images and
     fonts as data: URIs, data files served to the page's fetch() from memory. What it cannot find comes back in
     `notes`, so the model hears about it instead of the user finding an empty panel. */
  const MIME = { js: 'text/javascript', mjs: 'text/javascript', css: 'text/css', json: 'application/json', geojson: 'application/json', topojson: 'application/json', csv: 'text/csv', tsv: 'text/tab-separated-values', txt: 'text/plain', md: 'text/markdown', xml: 'application/xml', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon', bmp: 'image/bmp', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', mp4: 'video/mp4', webm: 'video/webm', wasm: 'application/wasm' };
  const mimeOf = (p) => MIME[(p.split('.').pop() || '').toLowerCase()] || 'application/octet-stream';
  const isLocal = (u) => !!u && !/^([a-z][a-z0-9+.-]*:|\/\/|#|\{\{|\$\{)/i.test(u.trim());
  function joinPath(dir, u) {
    const clean = u.trim().split(/[?#]/)[0];
    const out = clean.startsWith('/') ? [] : (dir ? dir.split('/') : []);
    for (const seg of clean.split('/')) { if (!seg || seg === '.') continue; if (seg === '..') out.pop(); else out.push(decodeURIComponent(seg)); }
    return out.join('/');
  }
  const dirOf = (p) => p.split('/').slice(0, -1).join('/');
  const DATA_FILE = /(['"`])((?:\.{0,2}\/)?[^'"`\s:]+\.(?:json|geojson|topojson|csv|tsv|txt|md|xml|svg|glsl|wgsl|frag|vert))\1/g;
  const MAX_ASSET = 8e6, MAX_DATA = 20e6;

  async function bundleHTML(html, { baseDir = '' } = {}) {
    const src = String(html || '');
    const notes = [], inlined = [];
    const doc = new DOMParser().parseFromString(src, 'text/html');
    const refs = [
      ...[...doc.querySelectorAll('script[src]')].map(e => [e, 'src']),
      ...[...doc.querySelectorAll('link[href]')].filter(e => /\b(stylesheet|icon|modulepreload|preload)\b/i.test(e.rel)).map(e => [e, 'href']),
      ...[...doc.querySelectorAll('img[src], source[src], video[src], audio[src], track[src], input[type=image][src], embed[src]')].map(e => [e, 'src']),
      ...[...doc.querySelectorAll('video[poster]')].map(e => [e, 'poster']),
    ].filter(([e, a]) => isLocal(e.getAttribute(a)));
    const scriptText = [...doc.querySelectorAll('script:not([src])')].map(e => e.textContent).join('\n');
    const mightFetch = DATA_FILE.test(scriptText); DATA_FILE.lastIndex = 0;
    const hasLocalImports = /\b(?:import|from)\s*\(?\s*['"]\.{0,2}\//.test(scriptText);
    const cssUrls = /url\(\s*['"]?(?![a-z][a-z0-9+.-]*:|#|\/\/)/i.test([...doc.querySelectorAll('style')].map(e => e.textContent).join('') + [...doc.querySelectorAll('[style]')].map(e => e.getAttribute('style')).join(''));
    if (!refs.length && !mightFetch && !hasLocalImports && !cssUrls) return { html: src, notes, inlined };
    if (!H.fs?.hasRoot?.()) {
      for (const [e, a] of refs) notes.push(`"${e.getAttribute(a)}" cannot load: the preview has no folder to read it from. Put its contents inline in the HTML, or save the files to the open folder and preview with run_file.`);
      return { html: src, notes, inlined };
    }
    const cache = new Map();
    const read = (path, binary) => {
      const k = (binary ? 'b:' : 't:') + path;
      if (!cache.has(k)) cache.set(k, H.fs.readFile(path, binary ? { binary: true } : undefined).then(v => v, () => null));
      return cache.get(k);
    };
    const dataURL = async (path) => {
      const blob = await read(path, true);
      if (!blob) return null;
      if (blob.size > MAX_ASSET) { notes.push(`${path} is ${Math.round(blob.size / 1e6)} MB, too large to build into the preview.`); return null; }
      const b = new Uint8Array(await blob.arrayBuffer());
      let bin = ''; for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
      inlined.push(path);
      return `data:${mimeOf(path)};base64,${btoa(bin)}`;
    };
    const missing = (u, path) => notes.push(`"${u}" was not found in the folder (looked for ${path || '(folder root)'}).`);
    const sources = [scriptText];   // every script's text, scanned afterwards for data files it may fetch

    /* Each match replaced by what fn returns for it (or kept, for null), in one pass from the left: no match is
       found again inside a replacement, and one path that ends another cannot be spliced into it. */
    async function replaceAsync(str, re, fn) {
      let out = '', last = 0;
      for (const m of str.matchAll(re)) { const r = await fn(m); out += str.slice(last, m.index) + (r ?? m[0]); last = m.index + m[0].length; }
      return out + str.slice(last);
    }
    /* @import and url(...) inside CSS, relative to the stylesheet's own folder. An imported sheet is rewritten in a
       call of its own, against its own folder, and what comes back is not looked at again. */
    const CSS_REF = /@import\s+(?:url\(\s*)?(['"]?)([^'")\s;]+)\1\s*\)?\s*([^;]*);|url\(\s*(['"]?)([^'")]+)\4\s*\)/g;
    function rewriteCSS(css, dir, depth = 0) {
      return replaceAsync(css, CSS_REF, async (m) => {
        if (m[2] != null) {
          if (!isLocal(m[2]) || depth > 5) return null;
          const path = joinPath(dir, m[2]); const t = await read(path);
          if (t == null) { missing(m[2], path); return null; }
          inlined.push(path);
          const inner = await rewriteCSS(t, dirOf(path), depth + 1);
          return m[3].trim() ? `@media ${m[3].trim()} {\n${inner}\n}` : inner;
        }
        if (!isLocal(m[5])) return null;
        const path = joinPath(dir, m[5]); const d = await dataURL(path);
        if (!d) { missing(m[5], path); return null; }
        return `url("${d}")`;
      });
    }
    /* an ES module and everything it imports by relative path, as data: URLs — the only form an imported module
       can take in a document without an address. Bare specifiers ('react') are left for an import map or CDN. */
    const modCache = new Map();
    const importMap = !!doc.querySelector('script[type=importmap]');   // bare specifiers are then the page's own business
    function rewriteModule(code, dir, stack = []) {
      return replaceAsync(code, /(\bfrom\s*|\bimport\s*\(?\s*)(['"])([^'"]+)\2/g, async (m) => {
        const u = m[3];
        if (!isLocal(u)) return null;
        if (!/^\.{0,2}\//.test(u)) { if (!importMap) notes.push(`Bare import "${u}" needs an import map or a full CDN URL (e.g. https://esm.sh/${u}).`); return null; }
        const path = joinPath(dir, u);
        if (stack.includes(path)) { notes.push(`Circular import of ${path} could not be built into the preview.`); return null; }
        let url = modCache.get(path);
        if (!url) {
          const t = await read(path);
          if (t == null) { missing(u, path); return null; }
          sources.push(t); inlined.push(path);
          url = 'data:text/javascript;base64,' + b64(await rewriteModule(t, dirOf(path), [...stack, path]));
          modCache.set(path, url);
        }
        return m[1] + m[2] + url + m[2];
      });
    }
    const b64 = (text) => { const b = new TextEncoder().encode(text); let bin = ''; for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(bin); };
    const safeScript = (t) => t.replace(/<\/script/gi, '<\\/script');

    const built = new Set();   // elements made from a file: already rewritten against that file's folder, not the page's
    for (const [e, a] of refs) {
      const u = e.getAttribute(a), path = joinPath(baseDir, u), tag = e.tagName;
      if (tag === 'SCRIPT') {
        const t = await read(path);
        if (t == null) { missing(u, path); continue; }
        inlined.push(path); sources.push(t);
        e.removeAttribute('src'); built.add(e);
        e.textContent = safeScript(e.type === 'module' ? await rewriteModule(t, dirOf(path)) : t);
      } else if (tag === 'LINK' && /\bstylesheet\b/i.test(e.rel)) {
        const t = await read(path);
        if (t == null) { missing(u, path); continue; }
        inlined.push(path);
        const st = doc.createElement('style');
        if (e.media) st.media = e.media;
        st.textContent = (await rewriteCSS(t, dirOf(path))).replace(/<\/style/gi, '<\\/style');
        e.replaceWith(st); built.add(st);
      } else if (tag === 'LINK' && /\b(modulepreload|preload)\b/i.test(e.rel)) {
        e.remove();   // the module is inlined where it is imported; a preload of the file would only be blocked
      } else {
        const d = await dataURL(path);
        if (!d) { missing(u, path); continue; }
        e.setAttribute(a, d);
      }
    }
    for (const e of doc.querySelectorAll('script[type=module]:not([src])')) if (!built.has(e)) e.textContent = safeScript(await rewriteModule(e.textContent, baseDir));
    for (const e of doc.querySelectorAll('style')) if (!built.has(e)) e.textContent = (await rewriteCSS(e.textContent, baseDir)).replace(/<\/style/gi, '<\\/style');
    for (const e of doc.querySelectorAll('[style]')) if (/url\(/i.test(e.getAttribute('style'))) e.setAttribute('style', await rewriteCSS(e.getAttribute('style'), baseDir));

    /* data files the scripts mention by name: served to fetch() from memory, since the page has nowhere to fetch
       them from. Stored once under the resolved path; ALIAS maps each spelling the scripts use onto it, so
       './data/x.json' and 'data/x.json' both hit without the file being carried twice. */
    const files = {}, alias = {}; let total = 0;
    for (const t of sources) for (const m of t.matchAll(DATA_FILE)) {
      const u = m[2], key = u.replace(/^\.\//, '');
      if (!isLocal(u) || alias[key] != null) continue;
      const path = joinPath(baseDir, u);
      if (!files[path]) {
        const blob = await read(path, true);
        if (!blob) continue;   // a string that only looks like a file name; not worth a note
        if (total + blob.size > MAX_DATA) { notes.push(`${path} was not built into the preview: data files are limited to ${MAX_DATA / 1e6} MB in total.`); continue; }
        total += blob.size; inlined.push(path);
        files[path] = { type: mimeOf(path), text: await blob.text() };
      }
      alias[key] = path;
    }
    if (Object.keys(files).length) {
      const shim = doc.createElement('script');
      shim.textContent = safeScript(`(() => {
  const FILES = ${JSON.stringify(files)}, ALIAS = ${JSON.stringify(alias)};
  const base = new URL('.', document.baseURI).href;
  const find = (input) => {
    const raw = String(input && input.url || input).split(/[?#]/)[0];
    const href = new URL(raw, document.baseURI).href;
    const rel = href.startsWith(base) ? decodeURIComponent(href.slice(base.length)) : null;
    const key = raw.replace(/^\\.\\//, '');
    return FILES[ALIAS[key] || key] || (rel && FILES[ALIAS[rel] || rel]) || null;
  };
  const real = window.fetch && window.fetch.bind(window);
  window.fetch = (input, init) => { const f = find(input); return f ? Promise.resolve(new Response(f.text, { status: 200, headers: { 'Content-Type': f.type } })) : real(input, init); };
  const open = XMLHttpRequest.prototype.open, send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u, ...r) { this.__file = find(u); return open.call(this, m, this.__file ? 'data:' + this.__file.type + ',' : u, ...r); };
  XMLHttpRequest.prototype.send = function (b) {
    if (!this.__file) return send.call(this, b);
    const f = this.__file;
    for (const [k, v] of [['readyState', 4], ['status', 200], ['statusText', 'OK'], ['responseText', f.text], ['response', this.responseType === 'json' ? JSON.parse(f.text) : f.text]]) Object.defineProperty(this, k, { value: v, configurable: true });
    setTimeout(() => { for (const t of ['readystatechange', 'load', 'loadend']) this.dispatchEvent(new Event(t)); });   // dispatchEvent runs the on* handlers too
  };
})();`);
      doc.head.prepend(shim);
    }
    const out = (/^\s*<!doctype/i.test(src) ? '<!doctype html>\n' : '') + doc.documentElement.outerHTML;
    return { html: out, notes: [...new Set(notes)], inlined: [...new Set(inlined)] };
  }

  /* What a preview said about itself, as the model should hear it: the problems first, and a word when the page
     drew nothing at all, which is how most broken pages look. */
  function describeReport(report, notes = []) {
    const out = {};
    if (notes.length) out.buildNotes = notes;
    if (!report) { out.diagnostics = 'The page did not report back within a few seconds (still loading, or replaced by another preview), so nothing is known about errors.'; return out; }
    if (report.issues.length) out.problems = report.issues.map(i => `${i.kind}: ${i.text}`);
    if (!report.textChars && report.elements < 3 && !report.canvases) out.warning = 'The page shows nothing: no text and almost no elements after loading. A script probably failed before it rendered.';
    out.page = { title: report.title || undefined, textChars: report.textChars, elements: report.elements, canvases: report.canvases || undefined };
    if (!report.issues.length && !out.warning) out.diagnostics = 'Loaded without errors.';
    else out.hint = 'Fix these and render again. "blocked" means the preview policy refused it: no network requests (fetch/XHR to remote URLs), no remote images (use inline SVG or data: URIs), scripts only inline, from files in the folder, or from cdnjs.cloudflare.com, cdn.jsdelivr.net, unpkg.com, esm.sh, cdn.tailwindcss.com, code.jquery.com.';
    return out;
  }

  /* evaluate a plugin-manifest expression in the Worker sandbox (no access to the page, storage or secrets) */
  async function evalExpr(kind, code, { data, args } = {}) {
    const body = kind === 'transform' ? `const data = input.data, args = input.args; return (${code});` : `return (${code})(input.args);`;
    const r = await runJS(body, { input: { data, args }, timeout: 5000, network: false });
    if (r.error) throw new Error(`${kind} expression failed: ${String(r.error).split('\n')[0]}`);
    return r.result;
  }
  return { runJS, runPython, previewHTML, previewPDF, bundleHTML, describeReport, evalExpr, pyodideLoaded: () => pyReady };
})();
