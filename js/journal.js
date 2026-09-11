/* What each chat changed on disk, and how to put it back.
   Git here is read-only by design, so "undo what the model just did" cannot be a checkout: instead every write,
   append, delete and move records the file's previous contents before it happens. The Changes panel shows the
   diff between what a file looked like when this chat first touched it and what it looks like now, and can
   restore it. Records live in IndexedDB next to the chat and are pruned by size. */
H.journal = (() => {
  const MAX_FILE = 1_000_000;         // per file: a bigger file is recorded, but without its contents
  const MAX_CHAT = 50_000_000;        // per chat, oldest first
  const MAX_DIR_FILES = 200;          // a recursive delete records at most this many files
  const BINARY = /\.(png|jpe?g|gif|webp|bmp|ico|pdf|zip|gz|tar|7z|exe|dll|so|dylib|woff2?|ttf|otf|mp[34]|m4a|wav|mov|avi|mkv|webm|bin|class|pyc|wasm|db|sqlite3?|jar)$/i;

  const enabled = () => H.settings.get('fileHistory') !== false;
  const chatId = () => { try { return H.agent.current()?.id || null; } catch { return null; } };

  let suspended = false;              // a revert is not itself a change worth recording

  /** read a file's current contents, or null when it does not exist / is not worth storing.
      "Does it exist?" is asked first even for binaries: a binary the chat *created* can still be undone by
      deleting it again, which needs no stored contents. */
  async function before(address) {
    let st = null;
    try { st = await H.fs.stat(address); } catch { }
    if (!st || st.kind !== 'file') return { text: null, missing: true };
    if (BINARY.test(address)) return { text: null, note: 'binary file' };
    if (st.size > MAX_FILE) return { text: null, note: `file larger than ${Math.round(MAX_FILE / 1e6)} MB` };
    try { return { text: await H.fs.readFile(address), size: st.size }; }
    catch (e) { return { text: null, note: 'it could not be read (' + e.message + ')' }; }
  }

  /** called by H.fs before it changes anything; never throws — a failed recording must not block the write.
      `forChat` is the chat whose run is writing. It has to be passed in: a chat keeps running when you switch
      away from it, so the chat on screen is not necessarily the one making the change, and filing a write under
      the wrong chat puts it in the wrong "Files changed" list — where Revert would restore it. */
  async function capture(path, op, forChat) {
    if (suspended || !enabled()) return;
    const chat = forChat || chatId(), f = H.fs.folder();
    if (!chat || !f) return;
    try {
      if (op === 'delete') {
        let st = null; try { st = await H.fs.stat(path); } catch { }
        if (st?.kind === 'directory') {                       // a folder delete is recorded file by file
          const entries = (await H.fs.list(path, { recursive: true, maxEntries: MAX_DIR_FILES, skipDir: () => false })).filter(e => e.kind === 'file');
          for (const e of entries) await put(chat, f, e.path, 'delete', await before(e.path));
          return;
        }
      }
      await put(chat, f, path, op, await before(path));
    } catch (e) { console.warn('journal', e); }
  }

  async function put(chat, f, path, op, b) {
    await H.db.journalPut({
      id: H.uid(), chat, at: Date.now(), op, path,
      folderId: f.id, folderName: f.name,
      before: b.text, missing: !!b.missing, note: b.note || null, bytes: b.text ? b.text.length : 0,
    });
    H.bus.emit('journal', chat);
    prune(chat);
  }
  /* Pruning has to respect what a revert actually needs. The undo baseline for a file is the *oldest* record for
     it — the state the chat found it in — so trimming oldest-first (as this used to) throws away exactly the thing
     "Revert" reads, and every later revert quietly restores an intermediate version instead.
     So: drop the redundant later records for a file first (they are only history), and only if that is still not
     enough drop whole files, oldest baseline first, marking them so the panel can say the history is gone. */
  let pruning = null, pruneAgain = false;
  function prune(chat) {
    if (pruning) { pruneAgain = true; return; }          // a burst of writes must not skip pruning altogether
    pruning = (async () => {
      try {
        do {
          pruneAgain = false;
          const rows = (await H.db.journalOf(chat)).sort((a, b) => a.at - b.at);
          let total = rows.reduce((n, r) => n + (r.bytes || 0), 0);
          if (total <= MAX_CHAT) break;
          const keyOf = (r) => r.folderId + '/' + r.path;
          const baseline = new Map();                     // key -> the oldest record, which holds `before`
          for (const r of rows) if (!baseline.has(keyOf(r))) baseline.set(keyOf(r), r);
          for (const r of rows) {                         // pass 1: later records for a file are history, not undo
            if (total <= MAX_CHAT) break;
            if (baseline.get(keyOf(r)) === r) continue;
            total -= r.bytes || 0; await H.db.journalDel(r.id);
          }
          for (const r of baseline.values()) {            // pass 2: give up whole files, oldest first, and say so
            if (total <= MAX_CHAT) break;
            total -= r.bytes || 0;
            await H.db.journalPut({ ...r, before: null, bytes: 0, note: 'the previous contents were dropped to stay within the history limit', dropped: true });
          }
        } while (pruneAgain);
      } catch (e) { console.warn('journal prune', e); } finally { pruning = null; }
    })();
  }

  /** one row per file this chat touched: the state before the chat started, and what it looks like now.
      A chat can be moved to another folder, and H.fs always speaks for the folder that is open *now*, so entries
      recorded in a different folder are listed but never read or written — reverting one would hit a same-named
      file in the wrong project. */
  async function list(chat = chatId()) {
    if (!chat) return [];
    const here = H.fs.folder()?.id || null;
    const rows = (await H.db.journalOf(chat)).sort((a, b) => a.at - b.at);
    const byFile = new Map();
    for (const r of rows) {
      const key = r.folderId + '/' + r.path;
      const e = byFile.get(key);
      if (!e) byFile.set(key, { ...r, ops: [r.op], count: 1, first: r.at, last: r.at });
      else { e.ops.push(r.op); e.count++; e.last = r.at; }
    }
    const out = [];
    for (const e of byFile.values()) {
      if (e.folderId !== here) {                    // written while this chat was in another folder
        out.push({ ...e, address: `${e.folderName}/${e.path}`, elsewhere: e.folderName, status: 'elsewhere', unchanged: false, revertible: false, patch: null, now: null, exists: null });
        continue;
      }
      const address = e.path;
      let now = null, exists = true;
      try { now = await H.fs.readFile(address); } catch { exists = false; }
      const status = !e.missing && !exists ? 'deleted' : e.missing && exists ? 'created' : 'modified';
      out.push({
        ...e, address, now, exists, status,
        /* what revert() will actually accept: a file the chat created needs no stored contents, anything else
           does — so a note (binary, oversized, or history the pruner dropped) rules it out */
        revertible: !!e.missing || !e.note,
        unchanged: (e.before ?? null) === (exists ? now : null),
        patch: e.note ? null : H.diff.unified(e.missing ? null : e.before, exists ? now : null, { path: address, context: 3 }),
      });
    }
    return out.sort((a, b) => b.last - a.last);
  }

  /** put one file back the way this chat found it */
  async function revert(entry) {
    if (entry.elsewhere || entry.folderId !== (H.fs.folder()?.id || null)) {
      throw new Error(`"${entry.address}" was changed while this chat was working in "${entry.folderName}". Open that folder again to put it back.`);
    }
    suspended = true;
    try {
      /* a file the chat created needs no stored contents to undo, so it is revertible even when there was
         nothing worth keeping (a binary, an oversized file, or history the pruner had to drop) */
      if (entry.missing) await H.fs.remove(entry.address).catch(() => { });   // the chat created it: remove it again
      else if (entry.note) throw new Error(`The previous contents of "${entry.address}" were not kept (${entry.note}).`);
      else await H.fs.writeFile(entry.address, entry.before);
      await forget(entry);
      return { ok: true };
    } finally { suspended = false; H.bus.emit('journal', chatId()); }
  }
  /** drop the records for one file (after a revert, there is nothing left to undo) */
  async function forget(entry) {
    const rows = await H.db.journalOf(entry.chat);
    for (const r of rows) if (r.folderId === entry.folderId && r.path === entry.path) await H.db.journalDel(r.id);
  }
  /* deliberately explicit: clear() without a chat id would otherwise wipe every chat's history */
  const clear = (chat) => (chat ? H.db.journalClear(chat).then(() => H.bus.emit('journal', chat)) : Promise.resolve());
  const clearAll = () => H.db.journalClear().then(() => H.bus.emit('journal', null));

  return { capture, list, revert, clear, clearAll, enabled };
})();
