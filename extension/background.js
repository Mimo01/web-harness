/* Service worker: performs fetches on behalf of the harness page.
   Two allow-lists (options page): harness page origins that may use the extension, and API origins it may call.
   The API origins are also real Chrome host permissions, granted one at a time from the options page — the
   extension ships with none, so until the user adds a site it cannot read or touch anything. */
const cfg = async () => chrome.storage.sync.get({ allowed: [], harness: [] });
const originOf = (u) => { try { return new URL(u).origin; } catch { return ''; } };
const granted = (origin) => chrome.permissions.contains({ origins: [origin + '/*'] }).catch(() => false);

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  if (msg.type === 'open-options') { chrome.runtime.openOptionsPage(); return; }
  (async () => {
    const { allowed, harness } = await cfg();
    const senderOrigin = sender.origin || originOf(sender.url || '');
    if (msg.type === 'is-harness-origin') { sendResponse({ ok: harness.includes(senderOrigin) && senderOrigin === msg.origin }); return; }
    if (msg.type !== 'harness-fetch') return;
    if (!harness.includes(senderOrigin)) { sendResponse({ error: 'NOT_HARNESS:' + senderOrigin }); return; }
    try {
      const origin = originOf(msg.url);
      if (!allowed.includes(origin)) { sendResponse({ error: `NOT_ALLOWED:${origin}` }); return; }
      if (!await granted(origin)) { sendResponse({ error: `NOT_GRANTED:${origin}` }); return; }
      const init = { method: msg.method || 'GET', headers: msg.headers || {}, credentials: msg.credentials === 'omit' ? 'omit' : 'include', redirect: 'follow' };
      if (msg.body !== undefined && init.method !== 'GET' && init.method !== 'HEAD') init.body = msg.body;
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), msg.timeout || 60000); init.signal = ctl.signal;
      const r = await fetch(msg.url, init); clearTimeout(t);
      const headers = {}; r.headers.forEach((v, k) => headers[k] = v);
      sendResponse({ status: r.status, ok: r.ok, headers, body: await r.text() });
    } catch (e) { sendResponse({ error: String(e && e.message || e) }); }
  })();
  return true;
});
