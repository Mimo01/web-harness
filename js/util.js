/* Shared helpers */
window.H = window.H || {};

H.uid = () => (crypto.randomUUID ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join(''));
H.now = () => Date.now();
H.sleep = (ms) => new Promise(r => setTimeout(r, ms));
H.esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
H.clamp = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n) + `\n…[truncated ${s.length - n} chars]` : s; };
H.fmtBytes = (n) => n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
H.fmtTime = (t) => new Date(t).toLocaleString();
H.fmtClock = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
H.relTime = (t) => { const d = (Date.now() - t) / 1000; if (d < 60) return 'just now'; if (d < 3600) return Math.floor(d / 60) + ' min ago'; if (d < 86400) return Math.floor(d / 3600) + ' h ago'; if (d < 7 * 86400) return Math.floor(d / 86400) + ' d ago'; return new Date(t).toLocaleDateString(); };
H.dateBucket = (t) => { const d = new Date(t), n = new Date(); const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime(); const diff = (day(n) - day(d)) / 86400000; if (diff <= 0) return 'Today'; if (diff === 1) return 'Yesterday'; if (diff < 7) return 'Previous 7 days'; if (diff < 30) return 'Previous 30 days'; return 'Older'; };
H.tryJSON = (s, fb) => { if (s == null) return fb; try { const v = JSON.parse(s); return v === null ? fb : v; } catch { return fb; } };
H.deepClone = (o) => JSON.parse(JSON.stringify(o));

/* Every localStorage write in the app goes through here. A full quota — or a browser that blocks storage
   altogether — must not throw out of a setter and take down whatever called it: it becomes one clear message
   and a `false` the caller can ignore. Returns whether the value actually landed. */
H.store = (() => {
  let lastToast = 0;
  return {
    write(key, value) {
      try { localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value)); return true; }
      catch (e) {
        const full = /quota|exceed/i.test((e?.name || '') + ' ' + (e?.message || ''));
        console.warn('localStorage write failed', key, e);
        if (Date.now() - lastToast > 10000) {   // a burst of failed writes is one problem, not twenty toasts
          lastToast = Date.now();
          H.toast(full
            ? 'This browser profile is out of local storage, so the last change could not be saved. Free space in Settings › Privacy & data, or export and wipe old data.'
            : 'Could not save to local storage: ' + (e?.message || e), 'error', 10000);
        }
        return false;
      }
    },
  };
})();
H.$ = (sel, root = document) => root.querySelector(sel);
H.$$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
H.el = (tag, attrs = {}, children = []) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of [].concat(children)) if (c != null) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
};

/* Tiny event bus */
H.bus = {
  _h: {},
  on(ev, fn) { (this._h[ev] ||= []).push(fn); return () => this.off(ev, fn); },
  off(ev, fn) { this._h[ev] = (this._h[ev] || []).filter(f => f !== fn); },
  emit(ev, ...a) { (this._h[ev] || []).forEach(f => { try { f(...a); } catch (e) { console.error(e); } }); }
};

/* Simple mustache-ish templating: {{a.b}} and {{json a}} */
H.template = (str, ctx) => String(str).replace(/\{\{\s*(json\s+)?([\w.\[\]-]+)\s*\}\}/g, (_, isJson, path) => {
  const v = path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), ctx);
  if (v === undefined || v === null) return '';
  if (isJson) return JSON.stringify(v);
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
});

/* Deep template over an object (strings templated, "{{json x}}" alone becomes the raw value) */
H.templateDeep = (obj, ctx) => {
  if (typeof obj === 'string') {
    const m = obj.match(/^\{\{\s*json\s+([\w.\[\]-]+)\s*\}\}$/);
    if (m) return m[1].split('.').reduce((o, k) => (o == null ? undefined : o[k]), ctx);
    const m2 = obj.match(/^\{\{\s*([\w.\[\]-]+)\s*\}\}$/);
    if (m2) { const v = m2[1].split('.').reduce((o, k) => (o == null ? undefined : o[k]), ctx); return v === undefined ? undefined : v; }
    return H.template(obj, ctx);
  }
  if (Array.isArray(obj)) return obj.map(x => H.templateDeep(x, ctx)).filter(x => x !== undefined);
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) { const r = H.templateDeep(v, ctx); if (r !== undefined && r !== '') out[k] = r; }
    return out;
  }
  return obj;
};

/* HTML -> readable text */
H.htmlToText = (html, baseUrl) => {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script,style,noscript,svg,iframe,nav,footer,header[role=banner],aside').forEach(n => n.remove());
  const title = doc.title || '';
  const root = doc.querySelector('main, article, [role=main]') || doc.body;
  const lines = [];
  const walk = (n) => {
    if (n.nodeType === 3) { lines.push(n.textContent); return; }
    if (n.nodeType !== 1) return;
    const tag = n.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) lines.push('\n' + '#'.repeat(+tag[1]) + ' ');
    if (tag === 'li') lines.push('\n- ');
    if (tag === 'br') lines.push('\n');
    if (tag === 'a' && n.getAttribute('href')) {
      let href = n.getAttribute('href');
      try { href = new URL(href, baseUrl).href; } catch { }
      lines.push('[' + n.textContent.trim() + '](' + href + ')'); return;
    }
    if (tag === 'pre') { lines.push('\n```\n' + n.textContent + '\n```\n'); return; }
    if (tag === 'code') { lines.push('`' + n.textContent + '`'); return; }
    if (['p', 'div', 'section', 'tr', 'blockquote', 'ul', 'ol', 'table'].includes(tag)) lines.push('\n');
    n.childNodes.forEach(walk);
    if (['p', 'div', 'section', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(tag)) lines.push('\n');
    if (tag === 'td' || tag === 'th') lines.push(' | ');
  };
  walk(root);
  const text = lines.join('').replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();
  return (title ? '# ' + title + '\n\n' : '') + text;
};

H.icon = (name, cls = 'ico') => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('class', cls); const u = document.createElementNS('http://www.w3.org/2000/svg', 'use'); u.setAttribute('href', '#i-' + name); s.append(u); return s; };

H.toast = (msg, kind = 'info', ms = 3500) => {
  const box = H.$('#toasts');
  const t = H.el('div', { class: 'toast ' + kind, text: msg });
  box.append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, ms);
  return t;
};

H.download = (name, content, type = 'text/plain') => {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = H.el('a', { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);   // long enough for the browser to start the download
};

/* One definition of "this chat as markdown": used by the Export button and by /copy all */
H.chatMarkdown = (c) => {
  const body = (c?.messages || []).map(m => m.role === 'tool'
    ? `### tool:${m.name}\n\`\`\`\n${H.clamp(m.content, 4000)}\n\`\`\``
    : `### ${m.role}\n${m.display || (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))}${m.tool_calls?.length ? '\n\n' + m.tool_calls.map(t => `→ ${t.function.name}(${t.function.arguments})`).join('\n') : ''}`).join('\n\n');
  return `# ${c?.title || 'Chat'}\n\n${body}`;
};

H.readFileAsText = (file) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsText(file); });
H.readFileAsDataURL = (file) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });

/* Turn browser / network exceptions into actionable explanations for the model */
H.explainError = (e, ctx = {}) => {
  const name = e?.name || ''; const msg = e?.message || String(e);
  const where = ctx.path ? ` (path: "${ctx.path}")` : ctx.url ? ` (url: ${ctx.url})` : '';
  const map = {
    NotFoundError: `Not found${where}. Paths are relative to the workspace root; use fs_list or fs_find to see what exists, and check spelling and case (case-sensitive on macOS/Linux).`,
    TypeMismatchError: `Wrong kind of entry${where}: expected a file but found a directory, or vice versa. Use fs_stat to check.`,
    NotAllowedError: `Access denied by the browser${where}. The workspace permission may have expired: ask the user to click the folder button under the message box and grant access again. Also make sure the file is not open exclusively in another program.`,
    InvalidModificationError: `Cannot modify${where}: the directory is not empty (pass recursive: true to delete it) or the name is invalid.`,
    NoModificationAllowedError: `The file is locked or read-only${where}. Ask the user to close it in other programs.`,
    QuotaExceededError: `Browser storage quota exceeded. Ask the user to free space or reduce the amount of data.`,
    SecurityError: `Blocked by browser security policy${where}. If the app is opened via file://, some features (workspace folders) need it to be served from an http(s) address.`,
    AbortError: `The operation was cancelled (by the user or a timeout).`,
    InvalidCharacterError: `Invalid characters${where}. On Windows, file names cannot contain \\ / : * ? " < > | and cannot be reserved names like CON or NUL.`,
    SyntaxError: `Syntax error: ${msg}`,
  };
  if (map[name]) return map[name];
  if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) return `Network request failed${where}: the browser could not reach the server, or the server does not allow cross-origin requests (CORS) from this page. This is not fixable by retrying. Options: open_url so the user can view it, or a plugin/bridge route for that site.`;
  if (/Not allowed to load local resource/i.test(msg)) return `Web pages cannot access local file:// URLs. Use the workspace file tools instead.`;
  if (/Document is not focused|clipboard/i.test(msg)) return `Clipboard access requires the harness tab to be focused. Ask the user to click into the page and try again.`;
  return msg;
};

/* Minimal JSON-schema check for tool arguments: required, types, enums. Returns null or an error string */
H.validateArgs = (schema, args) => {
  if (!schema || schema.type !== 'object') return null;
  const problems = [];
  for (const r of schema.required || []) if (args[r] === undefined || args[r] === null || args[r] === '') problems.push(`missing required parameter "${r}"`);
  const typeOf = (v) => Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v;
  for (const [k, def] of Object.entries(schema.properties || {})) {
    const v = args[k]; if (v === undefined || v === null || !def) continue;
    const want = def.type; const got = typeOf(v);
    if (want && ((want === 'number' || want === 'integer') ? got !== 'number' : want === 'boolean' ? got !== 'boolean' : want === 'array' ? got !== 'array' : want === 'object' ? got !== 'object' : want === 'string' ? got !== 'string' : false)) {
      if (want === 'number' && got === 'string' && v.trim() !== '' && !isNaN(+v)) { args[k] = +v; continue; }          // coerce "5" -> 5
      if (want === 'boolean' && got === 'string' && /^(true|false)$/i.test(v)) { args[k] = /^true$/i.test(v); continue; }
      if (want === 'string' && (got === 'number' || got === 'boolean')) { args[k] = String(v); continue; }
      if (want === 'object' && got === 'string') { const j = H.tryJSON(v, undefined); if (j && typeof j === 'object') { args[k] = j; continue; } }
      if (want === 'array' && got === 'string') { const j = H.tryJSON(v, undefined); if (Array.isArray(j)) { args[k] = j; continue; } }
      problems.push(`parameter "${k}" should be ${want} but got ${got}`);
    }
    if (def.enum && !def.enum.includes(args[k])) problems.push(`parameter "${k}" must be one of ${def.enum.map(x => JSON.stringify(x)).join(', ')}`);
  }
  const unknown = Object.keys(args).filter(k => schema.properties && !(k in schema.properties));
  if (unknown.length && schema.properties) problems.push(`unknown parameter(s) ${unknown.map(k => '"' + k + '"').join(', ')} ignored; valid: ${Object.keys(schema.properties).join(', ')}`);
  return problems.length ? problems.join('; ') : null;
};

/* JSON helpers for tool-call arguments */
H.isCompleteJSON = (s) => { try { JSON.parse(s); return true; } catch { return false; } };
/* Parse model-produced JSON leniently. Returns { value } or { error, truncated } */
H.parseArgs = (s) => {
  if (s == null || s === '') return { value: {} };
  let t = String(s).trim();
  try { return { value: JSON.parse(t) }; } catch { }
  // strip code fences / leading text
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const first = t.indexOf('{'); if (first > 0) t = t.slice(first);
  // concatenated objects: take the last complete one ({...}{...})
  const parts = []; let depth = 0, inStr = false, esc = false, start = -1;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true; else if (c === '{') { if (depth === 0) start = i; depth++; } else if (c === '}') { depth--; if (depth === 0 && start >= 0) { parts.push(t.slice(start, i + 1)); start = -1; } }
  }
  for (const p of parts.reverse()) { try { return { value: JSON.parse(p) }; } catch { } }
  // repair: raw control characters inside strings, trailing commas
  const fixed = (() => { let out = '', q = false, e = false; for (const c of t) { if (q) { if (e) { out += c; e = false; continue; } if (c === '\\') { e = true; out += c; continue; } if (c === '"') { q = false; out += c; continue; } if (c === '\n') { out += '\\n'; continue; } if (c === '\r') { out += '\\r'; continue; } if (c === '\t') { out += '\\t'; continue; } out += c; continue; } if (c === '"') q = true; out += c; } return out.replace(/,\s*([}\]])/g, '$1'); })();
  try { return { value: JSON.parse(fixed) }; } catch (e) {
    const truncated = depth > 0 || inStr || !/[}\]]\s*$/.test(t);
    return { error: e.message, truncated };
  }
};

/* Approximate token count */
H.estTokens = (s) => Math.ceil(String(s ?? '').length / 4);

/* A pattern the model wrote runs on the UI thread (fs_search, regex_extract), so one that backtracks
   catastrophically freezes the tab with no way to stop it. Nested quantifiers over a group are the shape that
   does it — (a+)+, (\w*)* — and refusing them costs nothing the model cannot express another way.
   Returns the pattern so it can be used inline; throws an explanation the model can act on. */
H.safeRegex = (pattern) => {
  const p = String(pattern);
  if (p.length > 1000) throw new Error('The regular expression is unreasonably long (over 1000 characters). Simplify it.');
  if (/\([^)]*[+*]\s*\)\s*[+*]|\([^)]*\{\d+,\}\s*\)\s*[+*{]/.test(p)) {
    throw new Error('This pattern nests a quantifier inside a quantified group (like "(a+)+"), which can take exponential time and would freeze the page. Rewrite it — usually the inner or the outer quantifier is redundant — or search for a plain substring instead.');
  }
  return p;
};
