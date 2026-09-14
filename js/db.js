/* IndexedDB persistence for chats + key/value store.
   v2 layout: `chats` holds full chats with image data replaced by references, `blobs` holds the image data (keyed by
   chat, written once), `chatIndex` holds one small record per chat (title, time, counts, search text, usage) so the
   sidebar and startup never read message bodies. In memory a chat always carries its images inline.
   v3 adds `folders` (every workspace folder the user ever picked, with its directory handle) and `journal`
   (what each chat changed on disk, with the previous contents, so a write can be undone).
   `memory` holds the model's own persistent notes (memory_save / memory_get), keyed by name.
   v4 changes no store, only what goes into a `chatIndex` record's search text (see searchText below), so the
   upgrade rebuilds those records from the chats already in the database. */
H.db = (() => {
  const NAME = 'llm-harness', VER = 4;
  let dbp;
  const known = new Set();   // blob ids already in the store (written once, never rewritten)

  /* What the sidebar search matches on: the conversation itself, gathered from the most recent end backwards
     until the budget runs out, so a chat stays findable by what was last said in it rather than only by how it
     opened. Both sides are indexed — half of what you remember about a chat is something the assistant said.
     Tool results are left out: they are most of a long chat's bytes and the least useful thing to match on, and
     indexing them would push the actual conversation out of the budget (and the record out of the sidebar's
     "small enough to hold them all in memory" class). */
  const SEARCH_CHARS = 20000;
  function searchText(c) {
    const msgs = c.messages || [];
    const parts = [];
    let left = SEARCH_CHARS;
    for (let i = msgs.length - 1; i >= 0 && left > 0; i--) {
      const m = msgs[i];
      if (m.role !== 'user' && m.role !== 'assistant') continue;
      const t = String(m.display || m.content || '').trim();
      if (!t) continue;
      parts.push(t.length > left ? t.slice(t.length - left) : t);   // the oldest message in budget keeps its tail
      left -= Math.min(t.length, left);
    }
    parts.reverse();
    return (c.title + ' ' + parts.join(' ')).toLowerCase();
  }
  /* the search/sidebar record for a chat */
  const summary = (c) => ({
    id: c.id, title: c.title, updated: c.updated, created: c.created, count: (c.messages || []).length, usage: c.usage || null,
    text: searchText(c),
  });
  /* split image data URLs out of a chat: returns the storable chat and the blobs referenced by it */
  function split(c) {
    const blobs = [];
    const messages = (c.messages || []).map(m => {
      if (!Array.isArray(m.apiContent)) return m;
      let changed = false;
      const parts = m.apiContent.map(p => {
        const url = p?.type === 'image_url' ? p.image_url?.url : null;
        if (!url || !/^data:/i.test(url)) return p;
        if (!p._ref) Object.defineProperty(p, '_ref', { value: H.uid(), enumerable: false });   // stable id, invisible to JSON/structured clone
        blobs.push({ id: p._ref, chat: c.id, data: url });
        changed = true;
        return { type: 'image_ref', ref: p._ref };
      });
      return changed ? { ...m, apiContent: parts } : m;
    });
    return { stored: { ...c, messages }, blobs };
  }
  /* put the image data back into a chat loaded from the store */
  function hydrate(c, blobs) {
    if (!c) return c;
    const byId = new Map((blobs || []).map(b => [b.id, b.data]));
    for (const m of c.messages || []) {
      if (!Array.isArray(m.apiContent) || !m.apiContent.some(p => p?.type === 'image_ref')) continue;
      m.apiContent = m.apiContent.map(p => {
        if (p?.type !== 'image_ref') return p;
        const data = byId.get(p.ref);
        if (!data) return { type: 'text', text: '(an image that was attached here is no longer available)' };
        known.add(p.ref);
        const part = { type: 'image_url', image_url: { url: data } };
        Object.defineProperty(part, '_ref', { value: p.ref, enumerable: false });
        return part;
      });
    }
    return c;
  }

  function open() {
    if (dbp) return dbp;
    const p = new Promise((res, rej) => {
      const req = indexedDB.open(NAME, VER);
      req.onupgradeneeded = (e) => {
        const db = e.target.result, t = e.target.transaction;
        if (!db.objectStoreNames.contains('chats')) db.createObjectStore('chats', { keyPath: 'id' }).createIndex('updated', 'updated');
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('memory')) db.createObjectStore('memory', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('chatIndex')) db.createObjectStore('chatIndex', { keyPath: 'id' }).createIndex('updated', 'updated');
        if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs', { keyPath: 'id' }).createIndex('chat', 'chat');
        if (!db.objectStoreNames.contains('folders')) db.createObjectStore('folders', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('journal')) { const j = db.createObjectStore('journal', { keyPath: 'id' }); j.createIndex('chat', 'chat'); j.createIndex('at', 'at'); }
        if (e.oldVersion < 2) {   // migrate v1 chats: build the index, move inline images to the blob store
          const chats = t.objectStore('chats'), idx = t.objectStore('chatIndex'), bl = t.objectStore('blobs');
          chats.openCursor().onsuccess = (ev) => {
            const cur = ev.target.result; if (!cur) return;
            const c = cur.value;
            try { const { stored, blobs } = split(c); idx.put(summary(c)); for (const b of blobs) bl.put(b); if (blobs.length) cur.update(stored); } catch { }
            cur.continue();
          };
        }
        if (e.oldVersion < 3) {   // the single workspace handle becomes the first row of the folder registry
          const kv = t.objectStore('kv'), folders = t.objectStore('folders');
          const req = kv.get('workspaceHandle');
          req.onsuccess = () => {
            const h = req.result?.value;
            if (!h) return;
            folders.put({ id: H.uid(), name: h.name, handle: h, mode: 'readwrite', lastUsed: Date.now() });
            kv.delete('workspaceHandle');
          };
        }
        if (e.oldVersion && e.oldVersion < 4) {   // the search text used to be the first 20 user messages: rebuild it from the whole conversation
          const chats = t.objectStore('chats'), idx = t.objectStore('chatIndex');
          chats.openCursor().onsuccess = (ev) => {
            const cur = ev.target.result; if (!cur) return;
            try { idx.put(summary(cur.value)); } catch { }
            cur.continue();
          };
        }
      };
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
      req.onblocked = () => rej(Object.assign(new Error('The database is open in another tab with an older version; close that tab and reload.'), { blocked: true }));
    });
    /* a failure must not be remembered: another tab holding an older version, or a transient storage error,
       would otherwise poison every later call for the lifetime of this page */
    p.catch((e) => {
      if (dbp === p) dbp = null;
      /* every failure is worth saying out loud, not only the "another tab holds an older version" one:
         without the database there are no chats, no memories and no folder registry, and a silent failure
         looks exactly like an app that works */
      try {
        H.toast(e?.blocked ? e.message : 'This browser profile would not open local storage (IndexedDB), so chats, memories and the list of folders you have opened cannot be read or saved: ' + (e?.message || e), 'error', 15000);
      } catch { }
    });
    dbp = p;
    return dbp;
  }
  /* run fn(store) or fn(transaction) inside one transaction; fn may return a request, a value, or a function evaluated on completion */
  async function tx(stores, mode, fn) {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction(stores, mode);
      const r = fn(Array.isArray(stores) ? t : t.objectStore(stores));
      t.oncomplete = () => res(typeof r === 'function' ? r() : r instanceof IDBRequest ? r.result : r);   // undefined when a record does not exist
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    });
  }
  const all = (store) => tx(store, 'readonly', s => s.getAll());
  const CHAT_STORES = ['chats', 'chatIndex', 'blobs'];

  async function getChat(id) {
    const r = await tx(['chats', 'blobs'], 'readonly', t => { const rc = t.objectStore('chats').get(id), rb = t.objectStore('blobs').index('chat').getAll(id); return () => ({ chat: rc.result, blobs: rb.result }); });
    return hydrate(r.chat, r.blobs);
  }
  async function putChat(c) {
    const { stored, blobs } = split(c);
    const fresh = blobs.filter(b => !known.has(b.id));
    await tx(CHAT_STORES, 'readwrite', t => { t.objectStore('chats').put(stored); t.objectStore('chatIndex').put(summary(c)); for (const b of fresh) t.objectStore('blobs').put(b); });
    for (const b of fresh) known.add(b.id);
  }
  const delChat = (id) => tx(CHAT_STORES, 'readwrite', t => {
    t.objectStore('chats').delete(id); t.objectStore('chatIndex').delete(id);
    const bl = t.objectStore('blobs');
    bl.index('chat').openKeyCursor(IDBKeyRange.only(id)).onsuccess = (e) => { const cur = e.target.result; if (!cur) return; known.delete(cur.primaryKey); bl.delete(cur.primaryKey); cur.continue(); };
  });
  /* newest chat's index record without reading anything else */
  const recentChat = () => tx('chatIndex', 'readonly', s => { const r = s.index('updated').openCursor(null, 'prev'); let v; r.onsuccess = () => { v = r.result?.value; }; return () => v; });
  /* full chats with images, for export only */
  async function allChats() {
    const r = await tx(['chats', 'blobs'], 'readonly', t => { const rc = t.objectStore('chats').getAll(), rb = t.objectStore('blobs').getAll(); return () => ({ chats: rc.result, blobs: rb.result }); });
    const byChat = new Map(); for (const b of r.blobs) { if (!byChat.has(b.chat)) byChat.set(b.chat, []); byChat.get(b.chat).push(b); }
    return r.chats.map(c => hydrate(c, byChat.get(c.id))).sort((a, b) => b.updated - a.updated);
  }

  return {
    getChat, putChat, delChat, recentChat, allChats, summary,
    listChats: async () => (await all('chatIndex')).sort((a, b) => b.updated - a.updated),   // light index records: no messages
    clearChats: () => tx(CHAT_STORES, 'readwrite', t => { for (const s of CHAT_STORES) t.objectStore(s).clear(); known.clear(); }),
    kvGet: async (k) => (await tx('kv', 'readonly', s => s.get(k)))?.value,
    kvSet: (k, v) => tx('kv', 'readwrite', s => s.put({ key: k, value: v })),
    folders: () => all('folders'),
    folderPut: (f) => tx('folders', 'readwrite', s => s.put(f)),
    /* a registry row holds a live directory handle, so "forget this folder" is a real revocation, not just tidying */
    folderDel: (id) => tx('folders', 'readwrite', s => s.delete(id)),
    journalPut: (rec) => tx('journal', 'readwrite', s => s.put(rec)),
    journalOf: (chat) => tx('journal', 'readonly', s => s.index('chat').getAll(chat)),
    journalDel: (id) => tx('journal', 'readwrite', s => s.delete(id)),
    journalClear: (chat) => tx('journal', 'readwrite', s => { if (!chat) return s.clear(); s.index('chat').openKeyCursor(IDBKeyRange.only(chat)).onsuccess = (e) => { const c = e.target.result; if (!c) return; s.delete(c.primaryKey); c.continue(); }; }),
    memGet: (k) => tx('memory', 'readonly', s => s.get(k)),
    memAll: () => all('memory'),
    memSet: (k, v, tags) => tx('memory', 'readwrite', s => s.put({ key: k, value: v, tags: tags || [], updated: Date.now() })),
    memDel: (k) => tx('memory', 'readwrite', s => s.delete(k)),
  };
})();
