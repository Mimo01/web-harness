/* Content script: only active on pages whose origin the user listed as a harness origin in the extension options,
   AND that mark themselves with data-llm-harness="1". Other sites never get a channel to the extension. */
(() => {
  const isMarked = () => document.documentElement && document.documentElement.getAttribute('data-llm-harness') === '1';
  chrome.runtime.sendMessage({ type: 'is-harness-origin', origin: location.origin }, (res) => {
    if (chrome.runtime.lastError || !res || !res.ok) return;
    if (isMarked()) start(); else { const obs = new MutationObserver(() => { if (isMarked()) { obs.disconnect(); start(); } }); obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-llm-harness'] }); }
  });
  function start() {
    window.addEventListener('message', (e) => {
      if (e.source !== window || !e.data || e.data.type !== 'llm-ext-fetch') return;
      const m = e.data;
      chrome.runtime.sendMessage({ type: 'harness-fetch', url: m.url, method: m.method, headers: m.headers, body: m.body, credentials: m.credentials, timeout: m.timeout }, (res) => {
        const err = chrome.runtime.lastError ? { error: chrome.runtime.lastError.message } : (res || { error: 'no response from extension' });
        window.postMessage({ type: 'llm-ext-result', id: m.id, ...err }, location.origin);
      });
    });
    window.addEventListener('message', (e) => { if (e.source === window && e.data && e.data.type === 'llm-ext-open-options') chrome.runtime.sendMessage({ type: 'open-options' }); });
    const announce = () => window.postMessage({ type: 'llm-ext-ready', version: chrome.runtime.getManifest().version }, location.origin);
    announce(); window.addEventListener('llm-ext-hello', announce);
  }
})();
