/* Browser-extension connector: if the "Web LLM Harness Connector" extension is installed, plugin requests can go through it.
   It performs the REST calls with the user's browser session (or the plugin's token) for origins allowed in the extension. */
H.ext = (() => {
  let version = null;
  const pending = new Map();
  document.documentElement.setAttribute('data-llm-harness', '1');   // lets the content script recognise this page
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data) return;
    if (e.data.type === 'llm-ext-ready') { const fresh = !version; version = e.data.version; if (fresh) H.bus.emit('ext', version); return; }
    if (e.data.type === 'llm-ext-result') { const p = pending.get(e.data.id); if (!p) return; clearTimeout(p.timer); pending.delete(e.data.id); p.resolve(e.data); }
  });
  window.dispatchEvent(new Event('llm-ext-hello'));
  setTimeout(() => window.dispatchEvent(new Event('llm-ext-hello')), 1500);

  function available() { return !!version; }
  function fetch(url, init = {}) {
    if (!version) return Promise.reject(new Error('The Web LLM Harness Connector extension is not installed or not active on this page.'));
    const id = H.uid();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('Extension request timed out')); }, (init.timeout || 60000) + 2000);
      pending.set(id, { resolve: (r) => { if (r.error) { if (r.error.startsWith('NOT_ALLOWED:')) reject(new Error(`${r.error.slice(12)} is not in the extension's allowed sites. Open the extension options (puzzle icon → Web LLM Harness Connector, or the "Allow this site" button in the plugin setup) and add it.`)); else reject(new Error('Extension: ' + r.error)); } else resolve(r); }, timer });
      window.postMessage({ type: 'llm-ext-fetch', id, url, method: init.method || 'GET', headers: init.headers || {}, body: init.body, credentials: init.credentials, timeout: init.timeout }, '*');
    });
  }
  function openOptions() { window.postMessage({ type: 'llm-ext-open-options' }, '*'); }
  return { available, version: () => version, fetch, openOptions };
})();
