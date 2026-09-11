/* Workspace file system.
   A chat works in ONE folder, opened by the user through the File System Access API (Chrome/Edge). Every path is
   relative to that folder's root ("src/app.js"): no prefixes, no absolute paths, nothing outside it. Folders the
   user has opened before are remembered in the `folders` registry so reopening one is a click. */
H.fs = (() => {
  let folder = null;             // { id, name, handle, mode:'read'|'readwrite', granted } | null
  const supported = () => typeof window.showDirectoryPicker === 'function';
  const hasRoot = () => !!folder;
  const changed = () => H.bus.emit('workspace', folder ? folder.name : '');

  /* ---------- registry of folders the user has opened before ---------- */
  const slug = (s) => String(s || 'folder').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|-+$/g, '') || 'folder';
  /* the same folder picked twice must keep its id, or it would collect a registry row per pick */
  async function findRow(handle) {
    for (const r of await H.db.folders()) { try { if (r.handle && await r.handle.isSameEntry(handle)) return r; } catch { } }
    return null;
  }
  /** open the OS picker and work in that folder. Needs a user gesture. */
  async function pick({ mode = 'readwrite' } = {}) {
    if (!supported()) throw new Error('This browser cannot open local folders: it has no File System Access API. Use Chrome or Edge.');
    let handle;
    try { handle = await window.showDirectoryPicker({ mode }); }
    catch (e) { if (e.name === 'SecurityError') throw new Error('The browser refused to open a folder from this page (file:// pages cannot use the File System Access API in some browsers). Serve the harness from an http(s) address, or use Chrome/Edge.'); throw e; }
    return await open(handle, { mode });
  }
  /** work in this folder from now on (in this chat); the folder it replaces is simply closed */
  async function open(handle, { mode = 'readwrite' } = {}) {
    const row = await findRow(handle) || { id: H.uid(), name: slug(handle.name) };
    await H.db.folderPut({ ...row, handle, mode, lastUsed: Date.now() });
    folder = { id: row.id, name: slug(handle.name), handle, mode, granted: true };
    changed();
    return folder.name;
  }
  function close() { folder = null; changed(); }
  function setMode(mode) {
    if (!folder) return;
    const f = folder;                              // the folder may be swapped before the registry write lands
    f.mode = mode;
    H.db.folders().then(rows => { const r = rows.find(x => x.id === f.id); if (r) H.db.folderPut({ ...r, mode }); }).catch(() => { });
    changed();
  }
  /** re-request permission. Must be called from a click: browsers require a user gesture. */
  async function grant() {
    if (!folder) return true;
    folder.granted = (await folder.handle.requestPermission({ mode: folder.mode })) === 'granted';
    changed();
    return folder.granted;
  }

  /** what a chat stores (the handle itself lives in the registry; the name is kept for display) */
  const state = () => (folder ? { folderId: folder.id, name: folder.name, mode: folder.mode } : null);
  /** adopt a chat's folder: look it up in the registry, keep it if it is still there */
  async function use(saved) {
    const want = Array.isArray(saved) ? saved.find(m => m.primary) || saved[0] : saved;      // chats saved before this
    if ((want?.folderId || null) === (folder?.id || null)) {
      if (folder && want.mode && want.mode !== folder.mode) { folder.mode = want.mode; changed(); }   // same folder, other chat's read-only choice
      return;
    }
    if (!want?.folderId) { folder = null; changed(); return; }
    const row = (await H.db.folders()).find(r => r.id === want.folderId);
    if (!row?.handle) { folder = null; changed(); return; }
    const mode = want.mode || row.mode || 'readwrite';
    let granted = false;
    try { granted = (await row.handle.queryPermission({ mode })) === 'granted'; } catch { }
    folder = { id: row.id, name: slug(row.handle.name), handle: row.handle, mode, granted };
    changed();
  }
  /* ---------- path resolution ---------- */
  /* Pure: turns whatever the model wrote into a path relative to the folder's root, or refuses it. Whether a folder
     is actually open (and writable, and still permitted) is ensure()'s business, not this one's. */
  function resolve(p) {
    let s = String(p ?? '').trim().replace(/\\/g, '/');
    if (s.startsWith('@@')) s = s.slice(1);
    else if (s.startsWith('@')) {
      const seg = s.slice(1).split('/')[0];
      if (folder && seg.toLowerCase() === folder.name.toLowerCase()) s = s.slice(1 + seg.length);   // naming the open folder is fine
      else throw new Error(`"@${seg}" is not a place this harness can reach. Every path is relative to the open folder${folder ? ` "${folder.name}"` : ' (none is open)'}, e.g. "src/app.js". (A file whose name really starts with "@" is written "@@${seg}".)`);
    }
    if (/^[a-zA-Z]:\//.test(s) || /^\/(Users|home|mnt|var|tmp)\//.test(s)) throw new Error(`"${p}" looks like an absolute path. Only paths relative to the open folder${folder ? ` "${folder.name}"` : ''} are allowed, e.g. "src/app.js".`);
    const parts = s.replace(/^\.?\/+/, '').replace(/\/+$/, '').split('/').filter(x => x && x !== '.');
    if (parts.includes('..')) throw new Error('Path traversal outside the workspace ("..") is not allowed.');
    return { parts, path: parts.join('/') };
  }
  const missing = (path, what) => Object.assign(new Error(`${what} "${path}" does not exist. Use fs_list/fs_find to locate it (names are case-sensitive on macOS/Linux)${what === 'File' ? ' or fs_write to create it' : ' (use fs_mkdir or write a file into it to create it)'}.`), { name: 'NotFoundError' });

  /* line endings: remember CRLF so edits keep the file's style */
  const eolOf = (t) => (t.match(/\r\n/g) || []).length > (t.match(/(?<!\r)\n/g) || []).length ? '\r\n' : '\n';

  /** a folder must be open, still permitted, and writable when the caller intends to write */
  async function ensure(write = false) {
    if (!folder) throw new Error('No folder is open, so there are no files to work with. Ask the user to click the folder button under the message box and pick the folder for this chat.');
    if (write && folder.mode !== 'readwrite') throw new Error(`The folder "${folder.name}" is open read-only. Ask the user to allow writing to it from the folder button under the message box.`);
    let p = 'denied';
    try { p = await folder.handle.queryPermission({ mode: folder.mode }); } catch { }
    if (p === 'granted') { if (!folder.granted) { folder.granted = true; changed(); } return; }
    try { if ((await folder.handle.requestPermission({ mode: folder.mode })) === 'granted') { folder.granted = true; changed(); return; } } catch { }
    folder.granted = false; changed();
    throw new Error(`The browser has not granted access to the folder "${folder.name}" in this session. Ask the user to click the folder button under the message box and choose "Grant access" — browsers only allow that from a click, so it cannot be done from a tool.`);
  }

  async function dirHandle(parts, create = false) {
    let d = folder.handle; const walked = [];
    for (const p of parts) {
      walked.push(p);
      try { d = await d.getDirectoryHandle(p, { create }); }
      catch (e) {
        if (e.name === 'NotFoundError') throw missing(walked.join('/'), 'Directory');
        if (e.name === 'TypeMismatchError') throw Object.assign(new Error(`"${walked.join('/')}" is a file, not a directory.`), { name: 'TypeMismatchError' });
        throw e;
      }
    }
    return d;
  }
  async function fileHandle(parts, create = false) {
    const p = parts.slice(); const name = p.pop();
    if (!name) throw new Error('Empty path');
    const d = await dirHandle(p, create);
    try { return await d.getFileHandle(name, { create }); }
    catch (e) {
      if (e.name === 'NotFoundError') throw missing(parts.join('/'), 'File');
      if (e.name === 'TypeMismatchError') throw Object.assign(new Error(`"${parts.join('/')}" is a directory, not a file.`), { name: 'TypeMismatchError' });
      throw e;
    }
  }

  /* ---------- public ops ---------- */
  async function readFile(path, { binary = false } = {}) {
    const { parts } = resolve(path);
    await ensure();
    const f = await (await fileHandle(parts)).getFile();
    return binary ? f : await f.text();
  }
  /* a change invalidates this folder's file index and content cache */
  const touched = () => { try { H.code.bump(); } catch { } };
  async function writeFile(path, content) {
    const { parts, path: rel } = resolve(path);
    await ensure(true);
    await H.journal?.capture(rel, 'write');
    touched();
    const w = await (await fileHandle(parts, true)).createWritable();
    await w.write(content);
    await w.close();
    return { bytes: typeof content === 'string' ? new Blob([content]).size : content.size ?? content.byteLength };
  }
  /* append without reading or rewriting the existing content: keep the file, seek to its end, write the new part */
  async function appendFile(path, content) {
    const { parts, path: rel } = resolve(path);
    await ensure(true);
    await H.journal?.capture(rel, 'append');
    touched();
    const fh = await fileHandle(parts, true);
    const size = (await fh.getFile()).size;
    const w = await fh.createWritable({ keepExistingData: true });
    await w.seek(size);
    await w.write(content);
    await w.close();
    return { bytes: new Blob([content]).size, size: size + new Blob([content]).size };
  }
  async function exists(path) { try { await stat(path); return true; } catch { return false; } }
  async function stat(path) {
    const { parts, path: rel } = resolve(path);
    await ensure();
    if (!parts.length) return { name: folder.name, kind: 'directory' };
    const name = parts[parts.length - 1];
    const d = await dirHandle(parts.slice(0, -1));
    try { const f = await (await d.getFileHandle(name)).getFile(); return { name, kind: 'file', size: f.size, modified: f.lastModified, type: f.type }; } catch { }
    try { await d.getDirectoryHandle(name); } catch { throw missing(rel, 'File'); }
    return { name, kind: 'directory' };
  }
  /* skipDir(name, path) decides which directories a recursive walk descends into. H.code passes the
     repository's .gitignore rules; without one the noise list below is used. */
  const DEFAULT_SKIP = ['node_modules', '.git', 'dist', 'build', '.venv', '__pycache__'];
  async function list(path = '', { recursive = false, maxEntries = 500, skipDir = null } = {}) {
    const { parts, path: base } = resolve(path);
    await ensure();
    const skip = skipDir || ((name) => DEFAULT_SKIP.includes(name));
    const out = [];
    async function walk(d, prefix) {
      for await (const [name, h] of d.entries()) {
        if (out.length >= maxEntries) return;
        const p = prefix ? prefix + '/' + name : name;
        if (h.kind === 'file') { const f = await h.getFile(); out.push({ path: p, kind: 'file', size: f.size, modified: f.lastModified }); }
        else { out.push({ path: p, kind: 'directory' }); if (recursive && !skip(name, p)) await walk(h, p); }
      }
    }
    await walk(await dirHandle(parts), base);
    return out;
  }
  async function mkdir(path) {
    const { parts } = resolve(path);
    await ensure(true);
    touched();
    await dirHandle(parts, true);
    return { ok: true };
  }
  async function remove(path, { recursive = false } = {}) {
    const { parts, path: rel } = resolve(path);
    await ensure(true);
    await H.journal?.capture(rel, 'delete');
    touched();
    const name = parts[parts.length - 1];
    const d = await dirHandle(parts.slice(0, -1));
    await d.removeEntry(name, { recursive });
    return { ok: true };
  }
  async function move(from, to) {
    const content = await readFile(from, { binary: true });
    await writeFile(to, content);
    await remove(from);
    return { ok: true };
  }
  /* glob -> regex. "**\/" spans any number of directories *including none*, so "src/**\/*.js" matches "src/a.js"
     as well as "src/deep/a.js"; a lone "*" stops at a slash. Falls back to matching the bare file name, so "*.md"
     finds "docs/readme.md" too. */
  function globMatch(glob, path) {
    let rx = '';
    for (let i = 0; i < glob.length; i++) {
      const c = glob[i];
      if (c === '*' && glob[i + 1] === '*') {
        if (glob[i + 2] === '/') { rx += '(?:.*/)?'; i += 2; } else { rx += '.*'; i += 1; }
      } else if (c === '*') rx += '[^/]*';
      else if (c === '?') rx += '[^/]';
      else rx += /[.+^${}()|[\]\\]/.test(c) ? '\\' + c : c;
    }
    const re = new RegExp('^' + rx + '$');
    return re.test(path) || re.test(path.split('/').pop());
  }
  /* CRLF-aware exact replacement; returns { text, count } or throws with a helpful message */
  function replaceText(text, oldStr, newStr, all) {
    const eol = eolOf(text);
    const lf = text.replace(/\r\n/g, '\n'); const o = String(oldStr).replace(/\r\n/g, '\n'); const n = String(newStr).replace(/\r\n/g, '\n');
    if (!o) throw new Error('old_string is empty; provide the exact text to replace.');
    let count = lf.split(o).length - 1;
    if (count === 0) {
      // help the model: find the closest line to what it tried
      const firstLine = o.split('\n')[0].trim();
      const near = firstLine && lf.split('\n').findIndex(l => l.includes(firstLine));
      throw new Error(`old_string was not found in the file (${text.length} chars). Whitespace, indentation and line breaks must match exactly.` + (near >= 0 ? ` A similar line exists at line ${near + 1}: use fs_read with a line range around it and copy the text verbatim.` : ' Use fs_read to view the current content first.'));
    }
    if (count > 1 && !all) throw new Error(`old_string occurs ${count} times; include more surrounding lines to make it unique, or set replace_all: true.`);
    const out = all ? lf.split(o).join(n) : lf.replace(o, () => n);
    return { text: eol === '\r\n' ? out.replace(/\n/g, '\r\n') : out, count: all ? count : 1 };
  }

  return {
    supported, pick, open, close, use, state, grant, setMode,
    folder: () => folder, resolve,
    /* which folder the file tools speak for right now. A run captures this at the start and checks it before
       every call: H.fs is global, so switching chats mid-run would otherwise aim a background chat's writes at
       whatever project the foreground chat just opened. */
    folderId: () => (folder ? folder.id : null),
    readFile, writeFile, appendFile, exists, stat, list, mkdir, remove, move, globMatch, replaceText, eolOf,
    name: () => (folder ? folder.name : ''), hasRoot,
    /** one line for the system prompt: which folder this chat works in */
    describe: () => (folder
      ? `The open folder is "${folder.name}"; every file path is relative to it ("src/app.js"), and there are no absolute paths.${folder.mode === 'read' ? ' It is READ-ONLY: you may read and search it, but every write will fail.' : ''}${folder.granted ? '' : ' ACCESS IS NOT GRANTED in this session: ask the user to click the folder button under the message box and grant it.'}`
      : `No folder is open, so the file tools have nothing to work with: ask the user to click the folder button under the message box and pick one.`),
  };
})();
