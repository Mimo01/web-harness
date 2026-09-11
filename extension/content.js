/* Content script: only active on pages whose origin the user listed as a harness origin in the extension options,
   AND that mark themselves with data-llm-harness="1". Other sites never get a channel to the extension.

   Replies go out with targetOrigin '*' rather than location.origin. Both ends live in the same window, so
   `e.source === window` (which js/ext.js checks, and which this script checks on the way in) is the exact scope
   test — a target origin adds nothing on top of it. It does subtract something: a harness opened from a file has
   an opaque origin, where postMessage(msg, location.origin) either throws ("null") or is silently dropped
   ("file://"). Verified: with location.origin === "null", Chrome throws
   `SyntaxError: Invalid target origin 'null'` — which killed the very announce() below, so the extension never
   appeared to be installed on exactly the file:// setup the options page tells people to configure. */
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
        window.postMessage({ type: 'llm-ext-result', id: m.id, ...err }, '*');
      });
    });
    window.addEventListener('message', (e) => { if (e.source === window && e.data && e.data.type === 'llm-ext-open-options') chrome.runtime.sendMessage({ type: 'open-options' }); });
    const announce = () => window.postMessage({ type: 'llm-ext-ready', version: chrome.runtime.getManifest().version }, '*');
    announce(); window.addEventListener('llm-ext-hello', announce);
  }
})();
