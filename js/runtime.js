/* Code execution: sandboxed JavaScript (Web Worker) and Python (Pyodide via CDN) */
H.runtime = (() => {
  /* ---- JavaScript in a Worker ---- */
  function runJS(code, { timeout = 15000, input } = {}) {
    return new Promise((resolve) => {
      const src = `
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

  /* ---- Python via Pyodide (loaded lazily from CDN) ---- */
  let pyodide = null, loading = null;
  async function getPyodide(onStatus) {
    if (pyodide) return pyodide;
    if (loading) return loading;
    if (!H.settings.get('allowPyodideCdn')) throw new Error('Python is disabled: downloading the Pyodide runtime is turned off in Settings > Security & privacy. Ask the user to enable it, or use run_javascript instead.');
    loading = (async () => {
      onStatus && onStatus('Loading Pyodide runtime (~10 MB, first time only)…');
      if (!window.loadPyodide) {
        await new Promise((res, rej) => { const s = document.createElement('script'); s.src = H.settings.get('pyodideUrl'); s.onload = res; s.onerror = () => rej(new Error('Failed to load Pyodide from ' + s.src)); document.head.append(s); });
      }
      const indexURL = H.settings.get('pyodideUrl').replace(/pyodide\.js$/, '');
      try { pyodide = await window.loadPyodide({ indexURL }); } catch (e) { loading = null; throw new Error('Pyodide failed to initialise: ' + e.message); }
      onStatus && onStatus('Pyodide ready');
      return pyodide;
    })();
    return loading;
  }
  async function runPython(code, { packages = [], files = {}, timeout = 60000, onStatus } = {}) {
    const py = await getPyodide(onStatus);
    if (packages.length) {
      onStatus && onStatus('Installing packages: ' + packages.join(', '));
      try { await py.loadPackage(packages); }
      catch { await py.loadPackage('micropip'); const mp = py.pyimport('micropip'); await mp.install(packages); }
    }
    for (const [name, content] of Object.entries(files)) py.FS.writeFile(name, content);
    let stdout = '', stderr = '';
    py.setStdout({ batched: (s) => { stdout += s + '\n'; } });
    py.setStderr({ batched: (s) => { stderr += s + '\n'; } });
    let result, error;
    const timer = new Promise((_, rej) => setTimeout(() => rej(new Error('Timed out after ' + timeout + ' ms')), timeout));
    try {
      await py.loadPackagesFromImports(code);
      result = await Promise.race([py.runPythonAsync(code), timer]);
      if (result && typeof result.toJs === 'function') { try { result = result.toJs({ dict_converter: Object.fromEntries }); } catch { result = String(result); } }
      if (result !== undefined && typeof result === 'object') { try { result = JSON.parse(JSON.stringify(result)); } catch { result = String(result); } }
    } catch (e) { error = String(e && e.message || e); const m = error.match(/(\w+Error: .*)$/m); if (m) error = m[1] + ' (see stderr/traceback; fix the code and run again)'; }
    return { stdout: stdout.trimEnd(), stderr: stderr.trimEnd(), result, error };
  }

  /* ---- HTML preview in a sandboxed iframe / new tab ---- */
  function previewHTML(html, { title = 'Preview' } = {}) {
    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    H.bus.emit('preview', { url, title, html });
    return url;
  }

  return { runJS, runPython, previewHTML, getPyodide, pyodideLoaded: () => !!pyodide };
})();
