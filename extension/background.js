/* Service worker: performs fetches on behalf of the harness page for allowed origins only. */
const getAllowed = async () => (await chrome.storage.sync.get({ allowed: [] })).allowed;

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'open-options') { chrome.runtime.openOptionsPage(); return; }
  if (!msg || msg.type !== 'harness-fetch') return;
  (async () => {
    try {
      const origin = new URL(msg.url).origin;
      const allowed = await getAllowed();
      if (!allowed.includes(origin)) { sendResponse({ error: `NOT_ALLOWED:${origin}` }); return; }
      const init = { method: msg.method || 'GET', headers: msg.headers || {}, credentials: msg.credentials === 'omit' ? 'omit' : 'include', redirect: 'follow' };
      if (msg.body !== undefined && init.method !== 'GET' && init.method !== 'HEAD') init.body = msg.body;
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), msg.timeout || 60000); init.signal = ctl.signal;
      const r = await fetch(msg.url, init); clearTimeout(t);
      const headers = {}; r.headers.forEach((v, k) => headers[k] = v);
      sendResponse({ status: r.status, ok: r.ok, headers, body: await r.text() });
    } catch (e) { sendResponse({ error: String(e && e.message || e) }); }
  })();
  return true; // async response
});
