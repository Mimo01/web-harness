/* Read-only git: reads a repository's .git directory directly from the workspace.
   Never writes anything into .git, so it can never corrupt a repository.
   Supports loose objects and packfiles (ofs/ref deltas), packed-refs, index v2/v3/v4. */
H.git = (() => {

  /* ============================ inflate (RFC 1950/1951) ============================
     Own implementation rather than DecompressionStream: a pack entry's compressed length is not
     stored anywhere, so a stream decompressor is fed trailing bytes from the next entry and errors.
     This one simply stops at the end of the deflate stream and reports how many bytes it consumed. */
  const NEED_MORE = 'inflate: unexpected end of input';
  const LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
  const LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
  const DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
  const DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
  const CLORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

  function huffman(lengths) {
    const counts = new Int32Array(16);
    for (const l of lengths) counts[l]++;
    counts[0] = 0;
    const offs = new Int32Array(16);
    for (let i = 1; i < 16; i++) offs[i] = offs[i - 1] + counts[i - 1];
    const symbols = new Int32Array(lengths.length);
    for (let s = 0; s < lengths.length; s++) if (lengths[s]) symbols[offs[lengths[s]]++] = s;
    return { counts, symbols };
  }
  const FIXED_LIT = huffman([...Array(288)].map((_, i) => i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8));
  const FIXED_DIST = huffman(new Array(30).fill(5));

  /** inflate a zlib (or raw deflate) stream from src[start]; returns { data, end } */
  function inflate(src, start = 0, { raw = false, expected = 0 } = {}) {
    let pos = start, bitBuf = 0, bitCnt = 0;
    if (!raw) {
      if (pos + 2 > src.length) throw new Error(NEED_MORE);
      const cmf = src[pos], flg = src[pos + 1];
      if ((cmf & 0x0f) !== 8 || ((cmf << 8) + flg) % 31 !== 0) throw new Error('not a zlib stream');
      pos += 2;
      if (flg & 0x20) pos += 4;   // preset dictionary (never used by git)
    }
    let out = new Uint8Array(Math.max(expected || 0, 1024)), len = 0;
    const need = (n) => { if (len + n > out.length) { let cap = out.length || 1024; while (cap < len + n) cap *= 2; const b = new Uint8Array(cap); b.set(out.subarray(0, len)); out = b; } };
    const bits = (n) => {
      while (bitCnt < n) { if (pos >= src.length) throw new Error(NEED_MORE); bitBuf |= src[pos++] << bitCnt; bitCnt += 8; }
      const v = bitBuf & ((1 << n) - 1); bitBuf >>>= n; bitCnt -= n; return v;
    };
    const decode = (h) => {
      let code = 0, first = 0, index = 0;
      for (let l = 1; l <= 15; l++) {
        code |= bits(1);
        const count = h.counts[l];
        if (code - first < count) return h.symbols[index + (code - first)];
        index += count; first = (first + count) << 1; code <<= 1;
      }
      throw new Error('inflate: bad Huffman code');
    };
    for (;;) {
      const last = bits(1), type = bits(2);
      if (type === 0) {
        bitBuf = 0; bitCnt = 0;
        if (pos + 4 > src.length) throw new Error(NEED_MORE);
        const n = src[pos] | (src[pos + 1] << 8); pos += 4;
        if (pos + n > src.length) throw new Error(NEED_MORE);
        need(n); out.set(src.subarray(pos, pos + n), len); len += n; pos += n;
      } else if (type === 1 || type === 2) {
        let lit = FIXED_LIT, dist = FIXED_DIST;
        if (type === 2) {
          const hlit = bits(5) + 257, hdist = bits(5) + 1, hclen = bits(4) + 4;
          const cl = new Uint8Array(19);
          for (let i = 0; i < hclen; i++) cl[CLORDER[i]] = bits(3);
          const clTree = huffman(cl);
          const lens = new Uint8Array(hlit + hdist);
          for (let i = 0; i < lens.length;) {
            const sym = decode(clTree);
            if (sym < 16) lens[i++] = sym;
            else if (sym === 16) { const prev = lens[i - 1]; let r = 3 + bits(2); while (r--) lens[i++] = prev; }
            else if (sym === 17) { let r = 3 + bits(3); while (r--) lens[i++] = 0; }
            else { let r = 11 + bits(7); while (r--) lens[i++] = 0; }
          }
          lit = huffman(lens.subarray(0, hlit)); dist = huffman(lens.subarray(hlit));
        }
        for (;;) {
          const sym = decode(lit);
          if (sym < 256) { need(1); out[len++] = sym; }
          else if (sym === 256) break;
          else {
            const li = sym - 257;
            if (li >= LBASE.length) throw new Error('inflate: bad length code');
            const l = LBASE[li] + bits(LEXT[li]);
            const di = decode(dist);
            const d = DBASE[di] + bits(DEXT[di]);
            if (d > len) throw new Error('inflate: distance too far back');
            need(l);
            for (let i = 0; i < l; i++) out[len + i] = out[len - d + i];
            len += l;
          }
        }
      } else throw new Error('inflate: invalid block type');
      if (last) break;
    }
    if (!raw) pos += 4;   // adler32
    return { data: out.subarray(0, len), end: pos };
  }

  /* ============================ low-level helpers ============================ */
  const enc = new TextEncoder(), dec = new TextDecoder('utf-8', { fatal: false });
  const hex = (u8, i = 0, n = 20) => { let s = ''; for (let k = i; k < i + n; k++) s += u8[k].toString(16).padStart(2, '0'); return s; };
  const unhex = (s) => { const u = new Uint8Array(s.length >> 1); for (let i = 0; i < u.length; i++) u[i] = parseInt(s.substr(i * 2, 2), 16); return u; };
  const isSha = (s) => /^[0-9a-f]{40}$/i.test(String(s || ''));
  const text = (u8) => dec.decode(u8);

  async function blobOf(path) {
    const f = await H.fs.readFile(path, { binary: true });
    return f instanceof Blob ? f : new Blob([f]);
  }
  async function bytesOf(path) { return new Uint8Array(await (await blobOf(path)).arrayBuffer()); }
  async function textOf(path) { return text(await bytesOf(path)); }
  async function exists(path) { try { await H.fs.stat(path); return true; } catch { return false; } }

  async function sha1Hex(u8) {
    if (!globalThis.crypto?.subtle) throw new Error('Web Crypto (crypto.subtle) is unavailable, so file contents cannot be hashed. Serve the harness over https or localhost, or use size/date comparison only.');
    return hex(new Uint8Array(await crypto.subtle.digest('SHA-1', u8)), 0, 20);
  }
  /** the sha git would give this content: sha1("blob <len>\0" + bytes) */
  async function hashBlob(u8) {
    const hdr = enc.encode(`blob ${u8.length}\0`);
    const buf = new Uint8Array(hdr.length + u8.length);
    buf.set(hdr); buf.set(u8, hdr.length);
    return sha1Hex(buf);
  }

  /* ============================ repository detection ============================ */
  let repo = null;           // { ok, root: '.git', reason }
  let gen = -1;              // H.code generation the caches belong to
  const objCache = new Map();    // sha -> { type, data }
  const treeCache = new Map();   // sha -> entries
  const mapCache = new Map();    // treeSha -> Map(path -> {sha, mode})
  let packs = null, refsCache = null, indexCache = null, headCache = null;

  function resetCaches() { objCache.clear(); treeCache.clear(); mapCache.clear(); packs = null; refsCache = null; indexCache = null; headCache = null; repo = null; }
  function checkGen() { const g = H.code?.generation?.() ?? 0; if (g !== gen) { gen = g; resetCaches(); } }

  const NO_REPO = (extra) => new Error(`This workspace is not a git repository (no .git directory in "${H.fs.name() || 'the workspace'}").${extra || ''} Folders extracted from a zip have no git history — use workspace_changes to see what changed since the folder was opened, or the GitHub/GitLab plugin for a hosted repository.`);

  async function detect() {
    checkGen();
    if (repo) return repo;
    if (!H.fs.hasRoot() && !H.fs.virtual.size) return (repo = { ok: false, reason: 'no-workspace' });
    let st = null;
    try { st = await H.fs.stat('.git'); } catch { }
    if (!st) return (repo = { ok: false, reason: 'no-git' });
    if (st.kind === 'file') return (repo = { ok: false, reason: 'gitfile' });
    return (repo = { ok: true, reason: '' });
  }
  async function requireRepo() {
    const r = await detect();
    if (r.ok) return r;
    if (r.reason === 'no-workspace') throw new Error('No workspace folder is open. Ask the user to click "Workspace" in the top bar and pick the project folder.');
    if (r.reason === 'gitfile') throw new Error('".git" here is a file, not a directory: this folder is a git submodule or linked worktree whose real git directory lives outside the workspace. The harness can only read a .git directory inside the folder you opened. Open the parent repository instead, or use workspace_changes.');
    throw NO_REPO();
  }

  /* ============================ object store ============================ */
  async function loadPacks() {
    if (packs) return packs;
    packs = [];
    let entries = [];
    try { entries = await H.fs.list('.git/objects/pack', { skipDir: () => false }); } catch { }
    for (const e of entries) {
      if (e.kind !== 'file' || !e.path.endsWith('.idx')) continue;
      const base = e.path.slice(0, -4);
      try {
        const idx = await bytesOf(e.path);
        const p = parseIdx(idx);
        if (p) packs.push({ ...p, pack: base + '.pack', packBlob: null });
      } catch (err) { console.warn('pack index unreadable', e.path, err); }
    }
    return packs;
  }
  function parseIdx(u8) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    if (!(u8[0] === 0xff && u8[1] === 0x74 && u8[2] === 0x4f && u8[3] === 0x63)) return null;   // v1 packs are ancient; skip
    if (dv.getUint32(4) !== 2) return null;
    const fanout = new Uint32Array(256);
    for (let i = 0; i < 256; i++) fanout[i] = dv.getUint32(8 + i * 4);
    const n = fanout[255];
    const shaStart = 8 + 256 * 4;
    const crcStart = shaStart + n * 20;
    const offStart = crcStart + n * 4;
    const big64Start = offStart + n * 4;
    return { u8, dv, fanout, n, shaStart, offStart, big64Start };
  }
  function idxFind(p, sha) {
    const b0 = parseInt(sha.slice(0, 2), 16);
    let lo = b0 === 0 ? 0 : p.fanout[b0 - 1], hi = p.fanout[b0];
    const target = unhex(sha);
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const at = p.shaStart + mid * 20;
      let cmp = 0;
      for (let i = 0; i < 20 && cmp === 0; i++) cmp = p.u8[at + i] - target[i];
      if (cmp === 0) {
        let off = p.dv.getUint32(p.offStart + mid * 4);
        if (off & 0x80000000) { const j = off & 0x7fffffff; off = Number(p.dv.getBigUint64(p.big64Start + j * 8)); }
        return off;
      }
      if (cmp < 0) lo = mid + 1; else hi = mid;
    }
    return -1;
  }
  /** every sha in a pack index that starts with `prefix` */
  function idxPrefix(p, prefix, out, limit = 10) {
    const b0 = parseInt(prefix.slice(0, 2).padEnd(2, '0'), 16);
    const lo = b0 === 0 ? 0 : p.fanout[b0 - 1], hi = p.fanout[Math.min(255, b0)];
    for (let i = lo; i < hi && out.length < limit; i++) { const s = hex(p.u8, p.shaStart + i * 20); if (s.startsWith(prefix)) out.push(s); }
  }

  const PACK_TYPES = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
  async function packBlob(p) { return (p.packBlob ||= await blobOf(p.pack)); }

  /** read a window of the pack big enough to inflate the entry at `offset`, growing on demand */
  async function readPackEntry(p, offset, depth = 0) {
    if (depth > 64) throw new Error('pack delta chain too deep');
    const blob = await packBlob(p);
    let window = 1 << 16;
    for (;;) {
      const end = Math.min(blob.size, offset + window);
      const buf = new Uint8Array(await blob.slice(offset, end).arrayBuffer());
      try {
        let i = 0;
        let b = buf[i++];
        const type = (b >> 4) & 7;
        let size = b & 15, shift = 4;
        while (b & 0x80) { b = buf[i++]; size += (b & 0x7f) * Math.pow(2, shift); shift += 7; }
        let baseRef = null, baseOfs = 0;
        if (type === 6) { b = buf[i++]; let ofs = b & 0x7f; while (b & 0x80) { b = buf[i++]; ofs = (ofs + 1) * 128 + (b & 0x7f); } baseOfs = offset - ofs; }
        else if (type === 7) { baseRef = hex(buf, i); i += 20; }
        if (i > buf.length) throw new Error(NEED_MORE);
        const { data } = inflate(buf, i, { expected: size });
        if (data.length !== size) throw new Error(NEED_MORE);
        if (type === 6 || type === 7) {
          const base = type === 6 ? await readPackEntry(p, baseOfs, depth + 1) : await readObject(baseRef);
          return { type: base.type, data: applyDelta(base.data, data) };
        }
        const t = PACK_TYPES[type];
        if (!t) throw new Error('unsupported pack object type ' + type);
        return { type: t, data };
      } catch (e) {
        if (String(e.message).includes(NEED_MORE) && end < blob.size) { window *= 4; continue; }
        throw e;
      }
    }
  }
  function applyDelta(base, delta) {
    let i = 0;
    const varint = () => { let v = 0, s = 0, b; do { b = delta[i++]; v += (b & 0x7f) * Math.pow(2, s); s += 7; } while (b & 0x80); return v; };
    varint();                       // base size (trusted from the base object itself)
    const outLen = varint();
    const out = new Uint8Array(outLen);
    let o = 0;
    while (i < delta.length) {
      const op = delta[i++];
      if (op & 0x80) {
        let off = 0, len = 0;
        if (op & 0x01) off |= delta[i++];
        if (op & 0x02) off |= delta[i++] << 8;
        if (op & 0x04) off |= delta[i++] << 16;
        if (op & 0x08) off += delta[i++] * 0x1000000;
        if (op & 0x10) len |= delta[i++];
        if (op & 0x20) len |= delta[i++] << 8;
        if (op & 0x40) len |= delta[i++] << 16;
        if (!len) len = 0x10000;
        out.set(base.subarray(off, off + len), o); o += len;
      } else if (op) { out.set(delta.subarray(i, i + op), o); o += op; i += op; }
      else throw new Error('invalid delta opcode 0');
    }
    return out;
  }

  /** { type, data } for a full 40-char sha */
  async function readObject(sha) {
    sha = String(sha).toLowerCase();
    if (!isSha(sha)) throw new Error(`"${sha}" is not a 40-character object id. Resolve a name with git_log/git_branches first.`);
    const hit = objCache.get(sha); if (hit) return hit;
    let obj = null;
    const loose = `.git/objects/${sha.slice(0, 2)}/${sha.slice(2)}`;
    if (await exists(loose)) {
      const { data } = inflate(await bytesOf(loose));
      const nul = data.indexOf(0);
      const [type, size] = text(data.subarray(0, nul)).split(' ');
      obj = { type, data: data.subarray(nul + 1, nul + 1 + Number(size)) };
    } else {
      for (const p of await loadPacks()) {
        const off = idxFind(p, sha);
        if (off >= 0) { obj = await readPackEntry(p, off); break; }
      }
    }
    if (!obj) {
      const alt = await exists('.git/objects/info/alternates');
      throw new Error(`Object ${sha.slice(0, 10)} is not in this repository's object store${alt ? ' (it uses .git/objects/info/alternates, which points outside the workspace and cannot be followed)' : ''}. The repository may be a shallow or partial clone.`);
    }
    if (objCache.size > 4000) objCache.clear();
    objCache.set(sha, obj);
    return obj;
  }

  /* ============================ commits, trees, refs ============================ */
  function parseCommit(sha, data) {
    const s = text(data);
    const split = s.indexOf('\n\n');
    const head = split < 0 ? s : s.slice(0, split);
    const message = split < 0 ? '' : s.slice(split + 2);
    const c = { sha, parents: [], message, subject: message.split('\n')[0] };
    for (const line of head.split('\n')) {
      const sp = line.indexOf(' '); if (sp < 0) continue;
      const k = line.slice(0, sp), v = line.slice(sp + 1);
      if (k === 'tree') c.tree = v;
      else if (k === 'parent') c.parents.push(v);
      else if (k === 'author' || k === 'committer') c[k] = person(v);
      else if (k === 'gpgsig') break;
    }
    c.date = c.author?.date || c.committer?.date || null;
    return c;
  }
  function person(v) {
    const m = v.match(/^(.*?)\s*<([^>]*)>\s*(\d+)?\s*([+-]\d{4})?/);
    if (!m) return { raw: v };
    const ts = m[3] ? Number(m[3]) * 1000 : null;
    return { name: m[1], email: m[2], date: ts ? new Date(ts).toISOString() : null, tz: m[4] || '' };
  }
  async function commit(sha) {
    const o = await readObject(sha);
    if (o.type === 'tag') return commit(parseTag(o.data).object);
    if (o.type !== 'commit') throw new Error(`${sha.slice(0, 10)} is a ${o.type}, not a commit.`);
    return parseCommit(sha, o.data);
  }
  function parseTag(data) {
    const t = {}; const s = text(data);
    for (const line of s.slice(0, s.indexOf('\n\n') + 1).split('\n')) { const sp = line.indexOf(' '); if (sp > 0) t[line.slice(0, sp)] ||= line.slice(sp + 1); }
    t.message = s.slice(s.indexOf('\n\n') + 2);
    if (t.tagger) t.tagger = person(t.tagger);
    return t;
  }
  async function tree(sha) {
    const hit = treeCache.get(sha); if (hit) return hit;
    const o = await readObject(sha);
    if (o.type !== 'tree') throw new Error(`${sha.slice(0, 10)} is a ${o.type}, not a tree.`);
    const out = []; const d = o.data;
    for (let i = 0; i < d.length;) {
      const sp = d.indexOf(0x20, i), nul = d.indexOf(0, sp);
      const mode = text(d.subarray(i, sp));
      const name = text(d.subarray(sp + 1, nul));
      out.push({ mode, name, sha: hex(d, nul + 1), kind: mode === '40000' || mode === '040000' ? 'tree' : mode === '160000' ? 'commit' : 'blob' });
      i = nul + 21;
    }
    treeCache.set(sha, out);
    return out;
  }
  /** every blob path under a tree: Map(path -> { sha, mode }) */
  async function treeMap(treeSha, { prefix = '', into = null } = {}) {
    if (!prefix && mapCache.has(treeSha)) return mapCache.get(treeSha);
    const map = into || new Map();
    for (const e of await tree(treeSha)) {
      const p = prefix ? prefix + '/' + e.name : e.name;
      if (e.kind === 'tree') await treeMap(e.sha, { prefix: p, into: map });
      else if (e.kind === 'blob') map.set(p, { sha: e.sha, mode: e.mode });
      else map.set(p, { sha: e.sha, mode: e.mode, submodule: true });
    }
    if (!prefix) { if (mapCache.size > 20) mapCache.clear(); mapCache.set(treeSha, map); }
    return map;
  }
  async function blobText(sha) { const o = await readObject(sha); return o.type === 'blob' ? text(o.data) : text(o.data); }
  async function blobBytes(sha) { return (await readObject(sha)).data; }

  async function packedRefs() {
    const out = new Map();
    if (!(await exists('.git/packed-refs'))) return out;
    for (const line of (await textOf('.git/packed-refs')).split('\n')) {
      if (!line || line[0] === '#' || line[0] === '^') continue;
      const sp = line.indexOf(' ');
      if (sp > 0) out.set(line.slice(sp + 1).trim(), line.slice(0, sp));
    }
    return out;
  }
  async function loadRefs() {
    if (refsCache) return refsCache;
    const refs = new Map(await packedRefs());
    for (const dir of ['.git/refs']) {
      let entries = [];
      try { entries = await H.fs.list(dir, { recursive: true, maxEntries: 5000, skipDir: () => false }); } catch { }
      for (const e of entries) {
        if (e.kind !== 'file') continue;
        try { const v = (await textOf(e.path)).trim(); if (isSha(v)) refs.set(e.path.replace(/^\.git\//, ''), v); else if (v.startsWith('ref: ')) refs.set(e.path.replace(/^\.git\//, ''), v.slice(5).trim()); } catch { }
      }
    }
    return (refsCache = refs);
  }
  async function head() {
    if (headCache) return headCache;
    const raw = (await textOf('.git/HEAD')).trim();
    let h;
    if (raw.startsWith('ref: ')) {
      const ref = raw.slice(5).trim();
      const refs = await loadRefs();
      h = { detached: false, ref, branch: ref.replace('refs/heads/', ''), sha: refs.get(ref) || null };
      if (!h.sha) h.unborn = true;   // a branch with no commit yet
    } else h = { detached: true, ref: null, branch: null, sha: raw };
    return (headCache = h);
  }
  async function config() {
    const out = {};
    if (!(await exists('.git/config'))) return out;
    let section = '';
    for (let line of (await textOf('.git/config')).split('\n')) {
      line = line.trim();
      if (!line || line[0] === '#' || line[0] === ';') continue;
      const s = line.match(/^\[([^\]]+)\]$/);
      if (s) { section = s[1].replace(/"/g, '').replace(/\s+/g, '.'); continue; }
      const i = line.indexOf('=');
      if (i > 0) out[`${section}.${line.slice(0, i).trim()}`] = line.slice(i + 1).trim();
    }
    return out;
  }

  /** resolve HEAD / branch / tag / sha / short sha, with ~n and ^n suffixes */
  async function resolve(rev) {
    let name = String(rev || 'HEAD').trim();
    if (!name) name = 'HEAD';
    const steps = [];
    name = name.replace(/(\^\d*|~\d+)+$/, (m) => { steps.push(...(m.match(/\^\d*|~\d+/g) || [])); return ''; }) || 'HEAD';
    let sha = await resolveBase(name);
    for (const st of steps) {
      if (st.startsWith('~')) { const n = Number(st.slice(1)) || 1; for (let i = 0; i < n; i++) { const c = await commit(sha); if (!c.parents[0]) throw new Error(`${rev}: reached the root commit before resolving ${st}.`); sha = c.parents[0]; } }
      else { const n = st.length > 1 ? Number(st.slice(1)) : 1; const c = await commit(sha); const p = c.parents[n - 1]; if (!p) throw new Error(`${rev}: commit ${sha.slice(0, 8)} has no parent ${n}.`); sha = p; }
    }
    return sha;
  }
  async function resolveBase(name) {
    if (name === 'HEAD') { const h = await head(); if (!h.sha) throw new Error(`HEAD points at "${h.ref}", which has no commits yet.`); return h.sha; }
    const refs = await loadRefs();
    for (const cand of [name, 'refs/heads/' + name, 'refs/tags/' + name, 'refs/remotes/' + name, 'refs/remotes/origin/' + name, 'refs/' + name]) {
      let v = refs.get(cand);
      let guard = 0;
      while (v && !isSha(v) && guard++ < 10) v = refs.get(v);
      if (v && isSha(v)) return await peel(v);
    }
    const s = name.toLowerCase();
    if (isSha(s)) return s;
    if (/^[0-9a-f]{4,39}$/.test(s)) {
      const found = await findPrefix(s);
      if (found.length === 1) return found[0];
      if (found.length > 1) throw new Error(`"${name}" is ambiguous: ${found.slice(0, 5).map(x => x.slice(0, 12)).join(', ')}.`);
    }
    const names = [...refs.keys()].filter(k => k.startsWith('refs/heads/')).map(k => k.slice(11));
    throw new Error(`Unknown revision "${name}". Local branches: ${names.slice(0, 20).join(', ') || '(none)'}. Use git_branches to list refs, or pass a 40-character sha.`);
  }
  async function peel(sha) { const o = await readObject(sha); return o.type === 'tag' ? peel(parseTag(o.data).object) : sha; }
  async function findPrefix(prefix) {
    const out = [];
    try {
      for (const e of await H.fs.list('.git/objects/' + prefix.slice(0, 2), { skipDir: () => false })) {
        if (e.kind === 'file') { const s = prefix.slice(0, 2) + e.path.split('/').pop(); if (s.startsWith(prefix)) out.push(s); }
      }
    } catch { }
    for (const p of await loadPacks()) idxPrefix(p, prefix, out);
    return [...new Set(out)];
  }

  /* ============================ index (.git/index) ============================ */
  async function readIndex() {
    if (indexCache) return indexCache;
    const map = new Map();
    if (!(await exists('.git/index'))) return (indexCache = map);
    const u8 = await bytesOf('.git/index');
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    if (text(u8.subarray(0, 4)) !== 'DIRC') throw new Error('.git/index is not in the expected DIRC format.');
    const version = dv.getUint32(4), count = dv.getUint32(8);
    let i = 12, prev = '';
    for (let n = 0; n < count && i < u8.length; n++) {
      const start = i;
      const mtime = dv.getUint32(i + 8) * 1000 + Math.round(dv.getUint32(i + 12) / 1e6);
      const mode = dv.getUint32(i + 24), size = dv.getUint32(i + 36);
      const sha = hex(u8, i + 40);
      const flags = dv.getUint16(i + 60);
      i += 62;
      if (version >= 3 && (flags & 0x4000)) i += 2;
      let name;
      if (version >= 4) {
        let strip = 0, s = 0, b;
        do { b = u8[i++]; strip += (b & 0x7f) * Math.pow(2, s); s += 7; } while (b & 0x80);
        const nul = u8.indexOf(0, i);
        name = prev.slice(0, prev.length - strip) + text(u8.subarray(i, nul));
        i = nul + 1;
      } else {
        const nul = u8.indexOf(0, i);
        name = text(u8.subarray(i, nul));
        i = start + Math.ceil((62 + (nul - (start + 62)) + 1) / 8) * 8;
      }
      prev = name;
      map.set(name, { sha, mode, size, mtime, stage: (flags >> 12) & 3 });
    }
    return (indexCache = map);
  }

  /* ============================ status & diff ============================ */
  const MTIME_SLOP = 1500;   // filesystem/index timestamp granularity

  /** working tree vs HEAD (and vs the index, when they differ) */
  async function status({ thorough = false, maxFiles = 4000 } = {}) {
    await requireRepo();
    const h = await head();
    const cfg = await config();
    const idx = await readIndex();
    const headMap = h.sha ? await treeMap((await commit(h.sha)).tree) : new Map();
    const files = await H.code.index();                    // ignore-aware working tree listing
    const onDisk = new Map(files.files.map(f => [f.path, f]));
    const tracked = idx.size ? idx : headMap;
    const auto = tracked.size <= 1500;                     // small repo: hash everything, always exact
    const doHash = thorough || auto;

    const modified = [], deleted = [], untracked = [], staged = [], unreadable = [];
    let hashed = 0;
    for (const [path, entry] of tracked) {
      /* git tracks a file even when .gitignore matches it, so a tracked path missing from the
         ignore-aware index is not necessarily gone: ask the file system before calling it deleted. */
      let f = onDisk.get(path);
      if (!f) {
        const s = await statOf(path);
        if (!s) { deleted.push(path); continue; }
        f = { path, size: s.size || 0, mtime: s.modified ?? s.mtime ?? 0 };
      }
      const ref = headMap.get(path) || entry;
      const sha = ref.sha;
      if (!sha) continue;
      let changed;
      if (f.size !== (idx.get(path)?.size ?? f.size)) changed = true;
      else if (!doHash && idx.has(path) && Math.abs(f.mtime - idx.get(path).mtime) < MTIME_SLOP) changed = false;
      else {
        try { changed = (await hashBlob(await bytesOf(path))) !== sha; hashed++; }
        catch (e) { unreadable.push(path); continue; }
      }
      if (changed) modified.push(path);
      if (idx.has(path) && headMap.has(path) && idx.get(path).sha !== headMap.get(path).sha) staged.push(path);
      else if (idx.has(path) && !headMap.has(path)) staged.push(path);
      if (modified.length + untracked.length > maxFiles) break;
    }
    for (const f of files.files) if (!tracked.has(f.path)) untracked.push(f.path);
    label = { branch: h.branch || (h.sha || '').slice(0, 8), dirty: modified.length + deleted.length, untracked: untracked.length };
    H.bus.emit('git-state', label);

    return {
      branch: h.branch, detached: h.detached, unborn: !!h.unborn,
      head: h.sha ? { sha: h.sha, short: h.sha.slice(0, 8), subject: (await commit(h.sha)).subject } : null,
      upstream: h.branch ? cfg[`branch.${h.branch}.merge`]?.replace('refs/heads/', '') : null,
      remote: cfg['remote.origin.url'] || null,
      modified, deleted, untracked: untracked.sort(), staged,
      counts: { modified: modified.length, deleted: deleted.length, untracked: untracked.length, staged: staged.length },
      clean: !modified.length && !deleted.length && !untracked.length,
      method: doHash ? 'content hash' : 'size + timestamp (fast); pass thorough:true to hash every file',
      hashedFiles: hashed,
      unreadable: unreadable.length ? unreadable : undefined,
    };
  }
  async function statOf(path) { try { const s = await H.fs.stat(path); return s.kind === 'file' ? s : null; } catch { return null; } }

  /** unified diff of the working tree against a commit (default HEAD) */
  async function diffWorktree({ ref = 'HEAD', paths = null, context = 3, thorough = false } = {}) {
    await requireRepo();
    const sha = await resolve(ref);
    const map = await treeMap((await commit(sha)).tree);
    const st = await status({ thorough });
    const want = (p) => !paths || paths.some(x => p === x || p.startsWith(x.replace(/\/$/, '') + '/'));
    const out = [];
    const deleted = new Set(st.deleted);
    for (const p of [...st.modified, ...st.deleted].sort()) {
      if (!want(p)) continue;
      const old = map.has(p) ? await blobText(map.get(p).sha) : null;
      if (deleted.has(p)) { out.push(fileDiff(p, old, null, context)); continue; }
      const cur = await readWorking(p);
      // a binary (or unreadable) file is still a change: never let it look like a deletion
      if (cur.binary || cur.error) { out.push({ path: p, status: 'modified', binary: true, note: cur.error || 'binary file; contents not shown' }); continue; }
      out.push(fileDiff(p, old, cur.text, context));
    }
    for (const p of st.untracked) {
      if (!want(p)) continue;
      const cur = await readWorking(p);
      if (cur.binary || cur.error) { out.push({ path: p, status: 'added', binary: true, note: cur.error || 'binary file; contents not shown' }); continue; }
      out.push(fileDiff(p, null, cur.text, context));
    }
    return { from: { ref, sha }, to: 'working tree', files: out.filter(Boolean) };
  }
  /** { text } | { binary: true } | { error } — never a bare null, which fileDiff would read as "deleted" */
  async function readWorking(path) {
    try { const u8 = await bytesOf(path); return u8.includes(0) ? { binary: true } : { text: text(u8) }; }
    catch (e) { return { error: 'could not be read: ' + e.message }; }
  }
  function fileDiff(path, oldText, newText, context, oldPath = null) {
    if (oldText === newText) return null;
    const patch = H.diff.unified(oldText, newText, { path, oldPath, context });
    const s = H.diff.stat(oldText ?? '', newText ?? '');
    return { path, oldPath: oldPath && oldPath !== path ? oldPath : undefined, status: oldText == null ? 'added' : newText == null ? 'deleted' : 'modified', added: s.added, removed: s.removed, patch };
  }

  /** diff between two commits/refs */
  async function diffRefs({ from, to = 'HEAD', paths = null, context = 3, statOnly = false } = {}) {
    await requireRepo();
    const aSha = await resolve(from), bSha = await resolve(to);
    const a = await treeMap((await commit(aSha)).tree), b = await treeMap((await commit(bSha)).tree);
    const want = (p) => !paths || paths.some(x => p === x || p.startsWith(x.replace(/\/$/, '') + '/'));
    const all = [...new Set([...a.keys(), ...b.keys()])].filter(want).sort();
    const files = [];
    for (const p of all) {
      const x = a.get(p), y = b.get(p);
      if (x && y && x.sha === y.sha) continue;
      if (statOnly) { files.push({ path: p, status: !x ? 'added' : !y ? 'deleted' : 'modified' }); continue; }
      const old = x ? await blobText(x.sha) : null, cur = y ? await blobText(y.sha) : null;
      const d = fileDiff(p, old, cur, context); if (d) files.push(d);
    }
    return { from: { ref: from, sha: aSha }, to: { ref: to, sha: bSha }, files };
  }

  /** paths changed by a commit relative to its first parent */
  async function commitChanges(sha, { context = 3, patch = false, paths = null } = {}) {
    const c = await commit(sha);
    const b = await treeMap(c.tree);
    const a = c.parents[0] ? await treeMap((await commit(c.parents[0])).tree) : new Map();
    const want = (p) => !paths || paths.some(x => p === x || p.startsWith(x.replace(/\/$/, '') + '/'));
    const out = [];
    for (const p of [...new Set([...a.keys(), ...b.keys()])].filter(want).sort()) {
      const x = a.get(p), y = b.get(p);
      if (x && y && x.sha === y.sha) continue;
      if (!patch) { out.push({ path: p, status: !x ? 'added' : !y ? 'deleted' : 'modified' }); continue; }
      const d = fileDiff(p, x ? await blobText(x.sha) : null, y ? await blobText(y.sha) : null, context);
      if (d) out.push(d);
    }
    return out;
  }

  /* ============================ history ============================ */
  async function log({ ref = 'HEAD', max = 20, path = null, author = null, since = null, until = null, messageContains = null, skip = 0 } = {}) {
    await requireRepo();
    const startSha = await resolve(ref);
    const sinceMs = since ? Date.parse(since) : null, untilMs = until ? Date.parse(until) : null;
    const seen = new Set(); const queue = [startSha]; const out = [];
    let walked = 0;
    const cap = Math.max(2000, (max + skip) * 40);
    let truncated = false, skipped = 0;
    while (queue.length && out.length < max) {
      if (walked++ > cap) { truncated = true; break; }
      const sha = queue.shift();
      if (seen.has(sha)) continue;
      seen.add(sha);
      let c; try { c = await commit(sha); } catch { continue; }
      for (const p of c.parents) if (!seen.has(p)) queue.push(p);
      // keep the frontier in date order so the log reads chronologically
      if (queue.length > 1) {
        const dated = [];
        for (const q of queue) { try { dated.push([q, Date.parse((await commit(q)).date || 0) || 0]); } catch { dated.push([q, 0]); } }
        dated.sort((x, y) => y[1] - x[1]);
        queue.length = 0; queue.push(...dated.map(d => d[0]));
      }
      if (sinceMs && Date.parse(c.date) < sinceMs) continue;
      if (untilMs && Date.parse(c.date) > untilMs) continue;
      if (author && !((c.author?.name || '') + ' ' + (c.author?.email || '')).toLowerCase().includes(author.toLowerCase())) continue;
      if (messageContains && !c.message.toLowerCase().includes(messageContains.toLowerCase())) continue;
      let touched = null;
      if (path) {
        touched = await commitChanges(sha, { paths: [path] });
        if (!touched.length) continue;
      }
      if (skipped++ < skip) continue;
      out.push({ sha, short: sha.slice(0, 8), subject: c.subject, author: c.author?.name, email: c.author?.email, date: c.date, parents: c.parents, files: touched ? touched.map(t => t.path) : undefined });
    }
    return { ref, commits: out, truncated: truncated || queue.length > 0 && out.length === max };
  }

  /** best-effort blame: walk the file's history and attribute each line to the commit that introduced it */
  async function blame(path, { ref = 'HEAD', maxRevisions = 40 } = {}) {
    await requireRepo();
    const hist = await log({ ref, path, max: maxRevisions });
    if (!hist.commits.length) throw new Error(`No commit in the history of ${ref} touches "${path}".`);
    const versions = [];
    for (const c of hist.commits) {
      const map = await treeMap((await commit(c.sha)).tree);
      const e = map.get(path);
      versions.push({ commit: c, text: e ? await blobText(e.sha) : null });
    }
    versions.reverse();                                   // oldest first
    const asLines = (t) => t == null ? [] : H.diff.splitLines(t.endsWith('\n') ? t.slice(0, -1) : t);
    let lines = asLines(versions[0].text).map(text => ({ text, commit: versions[0].commit }));
    for (const v of versions.slice(1)) {
      const next = asLines(v.text);
      const script = H.diff.lines(lines.map(l => l.text).join('\n'), next.join('\n'));
      const rebuilt = []; let oi = 0;
      for (const part of script) {
        if (part.t === '=') { for (const t of part.lines) rebuilt.push(lines[oi++] || { text: t, commit: v.commit }); }
        else if (part.t === '-') oi += part.lines.length;
        else for (const t of part.lines) rebuilt.push({ text: t, commit: v.commit });
      }
      lines = rebuilt;
    }
    return {
      path, ref, revisionsWalked: versions.length, truncated: hist.truncated || hist.commits.length >= maxRevisions,
      lines: lines.map((l, i) => ({ line: i + 1, sha: l.commit.short, author: l.commit.author, date: (l.commit.date || '').slice(0, 10), text: l.text })),
    };
  }

  async function branches() {
    await requireRepo();
    const refs = await loadRefs(), h = await head();
    const mk = async (name, sha) => {
      try { const c = await commit(sha); return { name, sha, short: sha.slice(0, 8), subject: c.subject, date: c.date, author: c.author?.name }; }
      catch { return { name, sha, short: sha.slice(0, 8) }; }
    };
    const local = [], remote = [], tags = [];
    for (const [ref, v] of refs) {
      if (!isSha(v)) continue;
      if (ref.startsWith('refs/heads/')) local.push(await mk(ref.slice(11), v));
      else if (ref.startsWith('refs/remotes/')) remote.push(await mk(ref.slice(13), v));
      else if (ref.startsWith('refs/tags/')) tags.push(await mk(ref.slice(10), await peel(v)));
    }
    const byDate = (a, b) => String(b.date || '').localeCompare(String(a.date || ''));
    return { current: h.detached ? null : h.branch, detached: h.detached, head: h.sha, branches: local.sort(byDate), remotes: remote.sort(byDate), tags: tags.sort(byDate) };
  }

  /* A short label for the top bar and the system prompt. The branch is cheap (one file); the number of
     changed files is only filled in once something has actually run git_status, never computed for a label. */
  let label = null;
  const state = () => label;
  async function quickBranch() {
    try {
      if (!(await detect()).ok) { label = null; H.bus.emit('git-state', null); return null; }
      const raw = (await textOf('.git/HEAD')).trim();
      const branch = raw.startsWith('ref: ') ? raw.slice(5).trim().replace('refs/heads/', '') : raw.slice(0, 8) + ' (detached)';
      label = { ...(label || {}), branch };
      H.bus.emit('git-state', label);
      return branch;
    } catch { label = null; return null; }
  }

  return {
    detect, requireRepo, head, config, resolve, readObject, commit, tree, treeMap, blobText, blobBytes,
    readIndex, status, diffWorktree, diffRefs, commitChanges, log, blame, branches, quickBranch, state,
    parseTag, hashBlob, inflate, resetCaches, isSha,
  };
})();
