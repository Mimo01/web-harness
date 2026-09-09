/* Workspace file system via File System Access API (Chrome/Edge). Falls back to an in-memory virtual FS elsewhere. */
H.fs = (() => {
  let root = null;               // FileSystemDirectoryHandle
  let rootName = '';
  const virtual = new Map();     // fallback: path -> content
  const supported = () => typeof window.showDirectoryPicker === 'function';

  async function pick() {
    if (!supported()) throw new Error('File System Access API not supported in this browser. Use Chrome/Edge, or the virtual in-memory workspace.');
    try { root = await window.showDirectoryPicker({ mode: 'readwrite' }); }
    catch (e) { if (e.name === 'SecurityError') throw new Error('The browser refused to open a folder from this page (file:// pages cannot use the File System Access API in some browsers). Serve the harness from an http(s) address, or use Chrome/Edge.'); throw e; }
    rootName = root.name;
    try { await H.db.kvSet('workspaceHandle', root); } catch { }
    H.bus.emit('workspace', rootName);
    return rootName;
  }
  async function restore() {
    try {
      const h = await H.db.kvGet('workspaceHandle');
      if (h) {
        const p = await h.queryPermission({ mode: 'readwrite' });
        if (p === 'granted') { root = h; rootName = h.name; H.bus.emit('workspace', rootName); return true; }
        // keep handle for later re-request
        root = h; rootName = h.name + ' (click to re-grant)';
        H.bus.emit('workspace', rootName);
      }
    } catch { }
    return false;
  }
  async function ensure() {
    if (!root) throw new Error('No workspace folder is open. Ask the user to click the "Workspace" button in the top bar and pick a folder; file tools work only inside that folder.');
    const p = await root.queryPermission({ mode: 'readwrite' });
    if (p !== 'granted') {
      const r = await root.requestPermission({ mode: 'readwrite' });
      if (r !== 'granted') throw new Error('Workspace permission not granted.');
      rootName = root.name; H.bus.emit('workspace', rootName);
    }
  }
  const norm = (p) => {
    let s = String(p || '').trim().replace(/\\/g, '/');
    if (/^[a-zA-Z]:\//.test(s) || /^\/(Users|home|mnt|var|tmp)\//.test(s)) throw new Error(`"${p}" looks like an absolute path. Only paths relative to the workspace root "${rootName || '(no workspace)'}" are allowed, e.g. "src/app.js".`);
    return s.replace(/^\.?\/+/, '').replace(/\/+$/, '').split('/').filter(x => x && x !== '.');
  };
  function guard(parts) { if (parts.includes('..')) throw new Error('Path traversal outside the workspace ("..") is not allowed.'); return parts; }
  /* line endings: remember CRLF so edits keep the file's style */
  const eolOf = (t) => (t.match(/\r\n/g) || []).length > (t.match(/(?<!\r)\n/g) || []).length ? '\r\n' : '\n';

  async function dirHandle(parts, create = false) {
    let d = root; const walked = [];
    for (const p of parts) {
      walked.push(p);
      try { d = await d.getDirectoryHandle(p, { create }); }
      catch (e) { if (e.name === 'NotFoundError') throw Object.assign(new Error(`Directory "${walked.join('/')}" does not exist${create ? '' : ' (use fs_mkdir or write a file into it to create it)'}.`), { name: 'NotFoundError' }); if (e.name === 'TypeMismatchError') throw Object.assign(new Error(`"${walked.join('/')}" is a file, not a directory.`), { name: 'TypeMismatchError' }); throw e; }
    }
    return d;
  }
  async function fileHandle(path, create = false) {
    const parts = guard(norm(path));
    const name = parts.pop();
    if (!name) throw new Error('Empty path');
    const d = await dirHandle(parts, create);
    try { return await d.getFileHandle(name, { create }); }
    catch (e) { if (e.name === 'NotFoundError') throw Object.assign(new Error(`File "${[...parts, name].join('/')}" does not exist. Use fs_list/fs_find to locate it (names are case-sensitive on macOS/Linux) or fs_write to create it.`), { name: 'NotFoundError' }); if (e.name === 'TypeMismatchError') throw Object.assign(new Error(`"${[...parts, name].join('/')}" is a directory, not a file.`), { name: 'TypeMismatchError' }); throw e; }
  }

  /* ---------- Public ops (work on real FS or virtual fallback) ---------- */
  async function readFile(path, { binary = false } = {}) {
    if (!root) { if (virtual.has(norm(path).join('/'))) return virtual.get(norm(path).join('/')); throw new Error('No workspace selected and file not in virtual FS: ' + path); }
    await ensure();
    const fh = await fileHandle(path);
    const f = await fh.getFile();
    if (binary) return f;
    return await f.text();
  }
  async function writeFile(path, content) {
    if (!root) { virtual.set(norm(path).join('/'), String(content)); return { virtual: true }; }
    await ensure();
    const fh = await fileHandle(path, true);
    const w = await fh.createWritable();
    await w.write(content);
    await w.close();
    return { bytes: typeof content === 'string' ? new Blob([content]).size : content.size ?? content.byteLength };
  }
  async function appendFile(path, content) {
    let prev = '';
    try { prev = await readFile(path); } catch { }
    return writeFile(path, prev + content);
  }
  async function exists(path) { try { await stat(path); return true; } catch { return false; } }
  async function stat(path) {
    if (!root) { const k = norm(path).join('/'); if (virtual.has(k)) return { name: k.split('/').pop(), kind: 'file', size: virtual.get(k).length }; throw new Error('Not found'); }
    await ensure();
    const parts = guard(norm(path));
    if (!parts.length) return { name: rootName, kind: 'directory' };
    const name = parts.pop();
    const d = await dirHandle(parts);
    try { const fh = await d.getFileHandle(name); const f = await fh.getFile(); return { name, kind: 'file', size: f.size, modified: f.lastModified, type: f.type }; } catch { }
    await d.getDirectoryHandle(name);
    return { name, kind: 'directory' };
  }
  async function list(path = '', { recursive = false, maxEntries = 500 } = {}) {
    if (!root) { return [...virtual.keys()].filter(k => !path || k.startsWith(norm(path).join('/'))).map(k => ({ path: k, kind: 'file', size: virtual.get(k).length })); }
    await ensure();
    const base = guard(norm(path));
    const out = [];
    async function walk(d, prefix) {
      for await (const [name, h] of d.entries()) {
        if (out.length >= maxEntries) return;
        const p = prefix ? prefix + '/' + name : name;
        if (h.kind === 'file') { const f = await h.getFile(); out.push({ path: p, kind: 'file', size: f.size, modified: f.lastModified }); }
        else { out.push({ path: p, kind: 'directory' }); if (recursive && !['node_modules', '.git', 'dist', 'build', '.venv', '__pycache__'].includes(name)) await walk(h, p); }
      }
    }
    await walk(await dirHandle(base), base.join('/'));
    return out;
  }
  async function mkdir(path) { if (!root) return { virtual: true }; await ensure(); await dirHandle(guard(norm(path)), true); return { ok: true }; }
  async function remove(path, { recursive = false } = {}) {
    if (!root) { virtual.delete(norm(path).join('/')); return { ok: true }; }
    await ensure();
    const parts = guard(norm(path)); const name = parts.pop();
    const d = await dirHandle(parts);
    await d.removeEntry(name, { recursive });
    return { ok: true };
  }
  async function move(from, to) {
    const content = await readFile(from, { binary: !!root });
    await writeFile(to, content);
    await remove(from);
    return { ok: true };
  }
  const isTextLike = (name) => !/\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tar|7z|exe|dll|so|dylib|woff2?|ttf|otf|mp[34]|mov|avi|bin|class|pyc|wasm)$/i.test(name);
  async function search({ query, path = '', regex = false, caseSensitive = false, glob = '', maxResults = 200 }) {
    const files = (await list(path, { recursive: true, maxEntries: 5000 })).filter(e => e.kind === 'file' && isTextLike(e.path) && (!glob || globMatch(glob, e.path)));
    const re = new RegExp(regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), caseSensitive ? 'g' : 'gi');
    const hits = [];
    for (const f of files) {
      if (f.size > 2_000_000) continue;
      let text; try { text = await readFile(f.path); } catch { continue; }
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) { hits.push({ file: f.path, line: i + 1, text: lines[i].trim().slice(0, 300) }); re.lastIndex = 0; if (hits.length >= maxResults) return hits; }
        re.lastIndex = 0;
      }
    }
    return hits;
  }
  function globMatch(glob, path) {
    const re = new RegExp('^' + glob.split('**').map(seg => seg.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')).join('.*') + '$');
    return re.test(path) || re.test(path.split('/').pop());
  }
  async function find(glob, path = '') {
    return (await list(path, { recursive: true, maxEntries: 5000 })).filter(e => globMatch(glob, e.path)).map(e => e.path);
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
  return { supported, pick, restore, readFile, writeFile, appendFile, exists, stat, list, mkdir, remove, move, search, find, globMatch, replaceText, eolOf, name: () => rootName, hasRoot: () => !!root, virtual };
})();
