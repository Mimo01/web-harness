/* Service worker: performs fetches on behalf of the harness page.
   Two allow-lists (options page): harness page origins that may use the extension, and API origins it may call.
   The API origins are also real Chrome host permissions, granted one at a time from the options page — the
   extension ships with none, so until the user adds a site it cannot read or touch anything. */
const cfg = async () => chrome.storage.sync.get({ allowed: [], harness: [], fileDir: '' });
const originOf = (u) => { try { return new URL(u).origin; } catch { return ''; } };
/* A harness opened from a file has an opaque origin, and the two ends disagree about how to spell it:
   `sender.origin` and `location.origin` are "file://" in most Chrome builds but "null" in some, and "null" is
   a truthy string, so the `sender.url` fallback below never ran. The options page stores "file://" (see
   options.js `norm`), so both sides are folded to that — which is the value already on the allow-list, so this
   widens nothing: an origin still has to be listed to be accepted. */
const canonical = (origin, url) => (!origin || origin === 'null' ? (/^file:/i.test(url || '') ? 'file://' : originOf(url || '')) : origin);
const granted = (origin) => chrome.permissions.contains({ origins: [origin + '/*'] }).catch(() => false);

/* "file://" is not an origin, it is every file on the disk. Allow-listing it — which is what the options page
   has to tell people to do for the double-click setup the README recommends — would otherwise let ANY local HTML
   file that sets data-llm-harness="1" use the extension, with the user's cookies, against every API origin they
   granted. A downloaded preview saved from the harness itself is enough to get such a file onto the disk.
   So the grant is narrowed to one folder: the first marked file:// page to identify itself as the harness binds
   it, and nothing outside that folder is accepted afterwards. The options page shows the folder and can forget
   it, which is how a harness that moved (or a wrong first binding) is re-pointed. */
const dirOf = (url) => { const u = String(url || '').split('#')[0].split('?')[0]; const i = u.lastIndexOf('/'); return i > 6 ? u.slice(0, i + 1) : ''; };
async function fileDirOk(url, { bind = false } = {}) {
  const dir = dirOf(url);
  if (!dir) return false;
  const { fileDir } = await cfg();
  if (fileDir) return dir === fileDir;
  if (!bind) return false;                                  // nothing bound yet: only the identify step may bind
  await chrome.storage.sync.set({ fileDir: dir });
  return true;
}

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  if (msg.type === 'open-options') { chrome.runtime.openOptionsPage(); return; }
  (async () => {
    const { allowed, harness } = await cfg();
    const senderOrigin = canonical(sender.origin, sender.url);
    const isFile = senderOrigin === 'file://';
    if (msg.type === 'is-harness-origin') {
      const ok = harness.includes(senderOrigin) && senderOrigin === canonical(msg.origin, sender.url)
        && (!isFile || await fileDirOk(sender.url, { bind: true }));
      sendResponse({ ok });
      return;
    }
    if (msg.type !== 'harness-fetch') return;
    if (!harness.includes(senderOrigin)) { sendResponse({ error: 'NOT_HARNESS:' + senderOrigin }); return; }
    if (isFile && !await fileDirOk(sender.url)) { sendResponse({ error: 'NOT_HARNESS:' + dirOf(sender.url) }); return; }
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
