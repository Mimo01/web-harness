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
  function runJS(code, { timeout = 15000, input, network = true, signal } = {}) {
    if (signal?.aborted) return Promise.resolve({ ...ABORTED });
    return new Promise((resolve) => {
      const src = `${NO_STORAGE}${network ? '' : NO_NETWORK}
        const __logs = [];
        const __fmt = (a) => a.map(x => { try { return typeof x === 'string' ? x : JSON.stringify(x, null, 1); } catch { return String(x); } }).join(' ');
        for (const k of ['log','info','warn','error','debug']) console[k] = (...a) => __logs.push((k==='log'?'':'['+k+'] ') + __fmt(a));
        self.onmessage = async (e) => {
          const input = e.data.input;
          let result, error;
          try {
            const fn = new (Object.getPrototypeOf(async function(){}).constructor)('input', e.data.code);
            result = await fn(input);
          } catch (err) { error = (err && err.stack) || String(err); }
          let out; try { out = result === undefined ? undefined : JSON.parse(JSON.stringify(result)); } catch { out = String(result); }
          self.postMessage({ logs: __logs, result: out, error });
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
      w.postMessage({ code, input });
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
          for (const [name, content] of Object.entries(m.files || {})) p.FS.writeFile(name, content);
          p.setStdout({ batched: (s) => { stdout += s + '\\n'; } });
          p.setStderr({ batched: (s) => { stderr += s + '\\n'; } });
          await p.loadPackagesFromImports(m.code);
          result = await p.runPythonAsync(m.code);
          if (result && typeof result.toJs === 'function') { try { result = result.toJs({ dict_converter: Object.fromEntries }); } catch { result = String(result); } }
          if (result !== undefined && typeof result === 'object') { try { result = JSON.parse(JSON.stringify(result)); } catch { result = String(result); } }
        } catch (err) {
          error = String(err && err.message || err);
          const mm = error.match(/(\\w+Error: .*)$/m); if (mm) error = mm[1] + ' (see stderr/traceback; fix the code and run again)';
        }
        post({ type: 'result', id: m.id, stdout: stdout.trimEnd(), stderr: stderr.trimEnd(), result, error });
      };`;
  }
  function pyStart() {
    const url = URL.createObjectURL(new Blob([pyWorkerSource()], { type: 'application/javascript' }));
    pyWorker = new Worker(url); URL.revokeObjectURL(url); pyReady = false;
    pyWorker.onmessage = (e) => {
      const m = e.data; const p = pyPending.get(m.id);
      if (m.type === 'status') { if (m.text === 'Pyodide ready') pyReady = true; p?.onStatus?.(m.text); return; }
      if (m.type === 'result' && p) { clearTimeout(p.timer); pyPending.delete(m.id); p.resolve({ stdout: m.stdout, stderr: m.stderr, result: m.result, error: m.error }); }
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
  function runPython(code, { packages = [], files = {}, timeout = 60000, onStatus, signal } = {}) {
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
      try { pyWorker.postMessage({ type: 'run', id, code, packages, files, url, indexURL }); }
      catch (e) { clearTimeout(timer); pyPending.delete(id); resolve({ error: 'Could not start Python: ' + e.message, stdout: '', stderr: '' }); }
    });
  }
  /* ---- HTML preview in a sandboxed iframe / new tab ---- */
  /* A srcdoc iframe inherits the page CSP (connect-src *), so model-authored HTML gets its own, stricter policy injected:
     no fetch/XHR/WebSocket, no form posts, no frames, images/media only inline; scripts and styles inline or from the
     two CDNs the app already trusts. */
  const PREVIEW_CSP = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net; style-src 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com; font-src data: https://fonts.gstatic.com; img-src data: blob:; media-src data: blob:; connect-src 'none'; form-action 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'";
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
  function hardenHTML(html) {
    const head = `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">` + PRINT_AGENT;
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
  function previewHTML(html, { title = 'Preview' } = {}) {
    H.bus.emit('preview', { title, html: hardenHTML(html), raw: String(html || '') });   // raw: what the model wrote, for Download   // sandboxed srcdoc iframe (unique origin) with an injected CSP; never a same-origin blob URL
    return 'preview';
  }

  /* evaluate a plugin-manifest expression in the Worker sandbox (no access to the page, storage or secrets) */
  async function evalExpr(kind, code, { data, args } = {}) {
    const body = kind === 'transform' ? `const data = input.data, args = input.args; return (${code});` : `return (${code})(input.args);`;
    const r = await runJS(body, { input: { data, args }, timeout: 5000, network: false });
    if (r.error) throw new Error(`${kind} expression failed: ${String(r.error).split('\n')[0]}`);
    return r.result;
  }
  return { runJS, runPython, previewHTML, previewPDF, evalExpr, pyodideLoaded: () => pyReady };
})();
