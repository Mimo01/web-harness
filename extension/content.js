/* Content script: activates only on pages that identify themselves as the Web LLM Harness (data-llm-harness on <html>). */
(() => {
  const check = () => document.documentElement && document.documentElement.getAttribute('data-llm-harness') === '1';
  if (!check()) { const obs = new MutationObserver(() => { if (check()) { obs.disconnect(); start(); } }); obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-llm-harness'] }); return; }
  start();
  function start() {
    window.addEventListener('message', (e) => {
      if (e.source !== window || !e.data || e.data.type !== 'llm-ext-fetch') return;
      const m = e.data;
      chrome.runtime.sendMessage({ type: 'harness-fetch', url: m.url, method: m.method, headers: m.headers, body: m.body, credentials: m.credentials, timeout: m.timeout }, (res) => {
        const err = chrome.runtime.lastError ? { error: chrome.runtime.lastError.message } : (res || { error: 'no response from extension' });
        window.postMessage({ type: 'llm-ext-result', id: m.id, ...err }, '*');
      });
    });
    window.addEventListener('message', (e) => {
      if (e.source !== window || !e.data || e.data.type !== 'llm-ext-open-options') return;
      chrome.runtime.sendMessage({ type: 'open-options' });
    });
    const announce = () => window.postMessage({ type: 'llm-ext-ready', version: chrome.runtime.getManifest().version }, '*');
    announce(); window.addEventListener('llm-ext-hello', announce);
  }
})();
