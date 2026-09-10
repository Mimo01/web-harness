/* Code execution: sandboxed JavaScript (Web Worker) and Python (Pyodide via CDN) */
H.runtime = (() => {
  /* ---- JavaScript in a Worker ---- */
  /* network:false removes every outbound channel a Worker has (fetch, XHR, WebSocket, EventSource, importScripts, nested
     workers, WebTransport, sendBeacon) before the user code runs, so an expression evaluated as a "safe" tool cannot exfiltrate. */
  const NO_NETWORK = `
        (() => {
          const dead = (n) => function () { throw new Error(n + ' is not available: this sandbox has no network access'); };
          const kill = (o, n) => { try { Object.defineProperty(o, n, { value: dead(n), writable: false, configurable: false }); } catch { try { o[n] = dead(n); } catch { } } };
          for (const n of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts', 'Worker', 'SharedWorker', 'WebTransport', 'RTCPeerConnection']) kill(self, n);
          if (self.navigator) kill(self.navigator, 'sendBeacon');
        })();`;
  function runJS(code, { timeout = 15000, input, network = true } = {}) {
    return new Promise((resolve) => {
      const src = `${network ? '' : NO_NETWORK}
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
      const finish = (v) => { clearTimeout(timer); w.terminate(); URL.revokeObjectURL(url); resolve(v); };
      const timer = setTimeout(() => finish({ error: `Timed out after ${timeout} ms. The code ran too long (infinite loop or slow network?); increase timeoutMs or simplify.`, logs: [] }), timeout);
      w.onmessage = (e) => finish(e.data);
      w.onerror = (e) => finish({ error: (e.message || 'Worker error') + ' (syntax error in the code? check the line reported)', logs: [] });
      w.postMessage({ code, input });
    });
  }

  /* ---- Python via Pyodide, inside a dedicated Worker ----
     The interpreter is loaded once and kept alive between runs. Because it runs off the main thread, a timeout can
     terminate it (an infinite loop cannot freeze the page); the next run then reloads the runtime. ---- */
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
    pyWorker.onerror = (e) => { for (const [id, p] of pyPending) { clearTimeout(p.timer); pyPending.delete(id); p.resolve({ error: 'Python worker error: ' + (e.message || 'unknown') + '. If Pyodide failed to load, check the network / Pyodide URL in Settings > Security & privacy.', stdout: '', stderr: '' }); } pyWorker = null; pyReady = false; };
  }
  function pyKill(reason) {
    if (!pyWorker) return;
    try { pyWorker.terminate(); } catch { }
    pyWorker = null; pyReady = false;
    for (const [id, p] of pyPending) { clearTimeout(p.timer); pyPending.delete(id); p.resolve({ error: reason, stdout: '', stderr: '' }); }
  }
  function runPython(code, { packages = [], files = {}, timeout = 60000, onStatus } = {}) {
    if (!H.settings.get('allowPyodideCdn')) return Promise.resolve({ error: 'Python is disabled: downloading the Pyodide runtime is turned off in Settings > Security & privacy. Ask the user to enable it, or use run_javascript instead.', stdout: '', stderr: '' });
    if (!pyWorker) pyStart();
    const id = ++pyId;
    const url = H.settings.get('pyodideUrl'); const indexURL = url.replace(/pyodide\.js$/, '');
    // first run includes the runtime download; give it extra time
    const budget = timeout + (pyReady ? 0 : 120000);
    return new Promise((resolve) => {
      const timer = setTimeout(() => pyKill(`Python timed out after ${Math.round(timeout / 1000)} s and was terminated (infinite loop or very slow code?). The runtime will reload on the next run. Increase timeoutMs or simplify the code.`), budget);
      pyPending.set(id, { resolve, timer, onStatus });
      try { pyWorker.postMessage({ type: 'run', id, code, packages, files, url, indexURL }); }
      catch (e) { clearTimeout(timer); pyPending.delete(id); resolve({ error: 'Could not start Python: ' + e.message, stdout: '', stderr: '' }); }
    });
  }
  const getPyodide = () => { throw new Error('Pyodide runs in a worker; use runPython'); };

  /* ---- HTML preview in a sandboxed iframe / new tab ---- */
  /* A srcdoc iframe inherits the page CSP (connect-src *), so model-authored HTML gets its own, stricter policy injected:
     no fetch/XHR/WebSocket, no form posts, no frames, images/media only inline; scripts and styles inline or from the
     two CDNs the app already trusts. */
  const PREVIEW_CSP = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net; style-src 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com; font-src data: https://fonts.gstatic.com; img-src data: blob:; media-src data: blob:; connect-src 'none'; form-action 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'";
  function hardenHTML(html) {
    const meta = `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">`;
    const src = String(html || '');
    let m = src.match(/<head[^>]*>/i);
    if (m) return src.slice(0, m.index + m[0].length) + meta + src.slice(m.index + m[0].length);
    m = src.match(/<html[^>]*>/i);
    if (m) return src.slice(0, m.index + m[0].length) + '<head>' + meta + '</head>' + src.slice(m.index + m[0].length);
    m = src.match(/^\s*<!doctype[^>]*>/i);
    if (m) return m[0] + meta + src.slice(m[0].length);
    return meta + src;
  }
  function previewHTML(html, { title = 'Preview' } = {}) {
    H.bus.emit('preview', { title, html: hardenHTML(html) });   // sandboxed srcdoc iframe (unique origin) with an injected CSP; never a same-origin blob URL
    return 'preview';
  }

  /* evaluate a plugin-manifest expression in the Worker sandbox (no access to the page, storage or secrets) */
  async function evalExpr(kind, code, { data, args } = {}) {
    const body = kind === 'transform' ? `const data = input.data, args = input.args; return (${code});` : `return (${code})(input.args);`;
    const r = await runJS(body, { input: { data, args }, timeout: 5000, network: false });
    if (r.error) throw new Error(`${kind} expression failed: ${String(r.error).split('\n')[0]}`);
    return r.result;
  }
  return { runJS, runPython, previewHTML, hardenHTML, PREVIEW_CSP, getPyodide, evalExpr, pyodideLoaded: () => pyReady };
})();
