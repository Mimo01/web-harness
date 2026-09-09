/* IndexedDB persistence for chats + key/value store */
H.db = (() => {
  const NAME = 'llm-harness', VER = 1;
  let dbp;
  function open() {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      const req = indexedDB.open(NAME, VER);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('chats')) {
          const s = db.createObjectStore('chats', { keyPath: 'id' });
          s.createIndex('updated', 'updated');
        }
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('memory')) db.createObjectStore('memory', { keyPath: 'key' });
      };
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    return dbp;
  }
  async function tx(store, mode, fn) {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction(store, mode);
      const s = t.objectStore(store);
      const r = fn(s);
      t.oncomplete = () => res(r && r.result !== undefined ? r.result : r);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    });
  }
  const all = (store) => tx(store, 'readonly', s => s.getAll());
  return {
    getChat: (id) => tx('chats', 'readonly', s => s.get(id)),
    listChats: async () => (await all('chats')).sort((a, b) => b.updated - a.updated),
    putChat: (c) => tx('chats', 'readwrite', s => s.put(c)),
    delChat: (id) => tx('chats', 'readwrite', s => s.delete(id)),
    clearChats: () => tx('chats', 'readwrite', s => s.clear()),
    kvGet: async (k) => (await tx('kv', 'readonly', s => s.get(k)))?.value,
    kvSet: (k, v) => tx('kv', 'readwrite', s => s.put({ key: k, value: v })),
    kvDel: (k) => tx('kv', 'readwrite', s => s.delete(k)),
    memGet: (k) => tx('memory', 'readonly', s => s.get(k)),
    memAll: () => all('memory'),
    memSet: (k, v, tags) => tx('memory', 'readwrite', s => s.put({ key: k, value: v, tags: tags || [], updated: Date.now() })),
    memDel: (k) => tx('memory', 'readwrite', s => s.delete(k)),
  };
})();
