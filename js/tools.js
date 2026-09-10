/* Built-in tool registry.
   Each tool: { name, group, description, parameters (JSON schema), risk: 'safe'|'write'|'danger', run(args, ctx) }
   risk drives the default permission: safe -> allow, write/danger -> ask */
H.tools = (() => {
  const registry = new Map();
  const def = (t) => { registry.set(t.name, t); return t; };
  const str = (d, extra = {}) => ({ type: 'string', description: d, ...extra });
  const num = (d, extra = {}) => ({ type: 'number', description: d, ...extra });
  const bool = (d) => ({ type: 'boolean', description: d });
  const obj = (props, required = []) => ({ type: 'object', properties: props, required });
  const ok = (data) => data;

  const SENSITIVE = /^(authorization|cookie|x-api-key|api-key|private-token|x-auth-token|x-atlassian-token|proxy-authorization)$/i;
  /* direct fetch; if the browser blocks it (CORS) and the user configured a proxy, retry through the proxy —
     but never replay requests that carry credentials or a body, never after a timeout/abort, and only GET/HEAD */
  async function fetchWithProxy(url, init = {}, { allowProxy = true } = {}) {
    const proxy = H.settings.get('corsProxy');
    try { return await fetch(url, init); }
    catch (e) {
      const method = (init.method || 'GET').toUpperCase();
      const hasSecret = Object.keys(init.headers || {}).some(h => SENSITIVE.test(h));
      const eligible = allowProxy && proxy && e.name !== 'AbortError' && (method === 'GET' || method === 'HEAD') && init.body === undefined && !hasSecret;
      if (eligible) {
        const p = proxy.includes('{url}') ? proxy.replace('{url}', encodeURIComponent(url)) : proxy + (proxy.endsWith('=') || proxy.endsWith('?') ? encodeURIComponent(url) : url);
        return await fetch(p, { method, headers: init.headers, signal: init.signal });
      }
      throw e;
    }
  }

  /* ===================== FILE SYSTEM ===================== */
  def({
    name: 'fs_list', group: 'Files', risk: 'safe',
    description: 'List files and directories in the workspace. Returns paths relative to workspace root.',
    parameters: obj({ path: str('Directory path relative to workspace root (empty = root)'), recursive: bool('List recursively (skips node_modules/.git etc.)') }),
    run: async ({ path = '', recursive = false }) => ok({ workspace: H.fs.name(), entries: await H.fs.list(path, { recursive }) }),
  });
  def({
    name: 'fs_read', group: 'Files', risk: 'safe',
    description: 'Read a file from the workspace as text. PDF, Word (.docx), PowerPoint (.pptx) and spreadsheets (.xlsx/.xls/.ods/.csv) are converted to text automatically. Optionally a line range.',
    parameters: obj({ path: str('File path'), startLine: num('1-based first line (optional)'), endLine: num('1-based last line inclusive (optional)') }, ['path']),
    run: async ({ path, startLine, endLine }, ctx) => {
      let text;
      if (H.extract.kindOf(path) === 'image') throw new Error(`${path} is an image. Use view_image to look at it.`);
      if (['video', 'audio', 'binary', 'heic'].includes(H.extract.kindOf(path))) throw new Error(`${path} is a ${H.extract.kindOf(path)} file; it has no text to read. (Videos/audio can be attached by the user in the chat for frame sampling / transcription.)`);
      if (H.extract.isDocument(path)) {
        const file = await H.fs.readFile(path, { binary: true });
        const blob = file instanceof Blob ? file : new Blob([file]);
        const r = await H.extract.fromFile(Object.assign(blob, { name: path.split('/').pop() }), { onStatus: ctx?.onStatus });
        if (r.kind !== 'text') throw new Error(r.note || 'No text could be extracted');
        text = r.text ?? r.content; if (r.note) text = `[${r.note}]\n` + text;
      } else text = (await H.fs.readFile(path)).replace(/\r\n/g, '\n');
      const lines = text.split('\n');
      const s = Math.max(1, startLine || 1), e = Math.min(lines.length, endLine || lines.length);
      const slice = lines.slice(s - 1, e).map((l, i) => `${String(s + i).padStart(5)}| ${l}`).join('\n');
      return ok({ path, totalLines: lines.length, from: s, to: e, content: H.clamp(slice, 60000) });
    },
  });
  def({
    name: 'fs_write', group: 'Files', risk: 'write',
    description: 'Create or overwrite a text file in the workspace. Parent directories are created automatically.',
    parameters: obj({ path: str('File path'), content: str('Full file content') }, ['path', 'content']),
    run: async ({ path, content }) => ok({ path, ...(await H.fs.writeFile(path, content)) }),
  });
  def({
    name: 'fs_edit', group: 'Files', risk: 'write',
    description: 'Edit a file by replacing an exact string with another. old_string must occur exactly once unless replace_all is true.',
    parameters: obj({ path: str('File path'), old_string: str('Exact text to replace'), new_string: str('Replacement text'), replace_all: bool('Replace all occurrences') }, ['path', 'old_string', 'new_string']),
    run: async ({ path, old_string, new_string, replace_all }) => {
      const text = await H.fs.readFile(path);
      const r = H.fs.replaceText(text, old_string, new_string, !!replace_all);
      await H.fs.writeFile(path, r.text);
      return ok({ path, replacements: r.count });
    },
  });
  def({
    name: 'fs_append', group: 'Files', risk: 'write',
    description: 'Append text to a file (creates it if missing).',
    parameters: obj({ path: str('File path'), content: str('Text to append') }, ['path', 'content']),
    run: async ({ path, content }) => ok({ path, ...(await H.fs.appendFile(path, content)) }),
  });
  def({
    name: 'fs_mkdir', group: 'Files', risk: 'write',
    description: 'Create a directory (recursively).',
    parameters: obj({ path: str('Directory path') }, ['path']),
    run: async ({ path }) => ok(await H.fs.mkdir(path)),
  });
  def({
    name: 'fs_delete', group: 'Files', risk: 'danger',
    description: 'Delete a file or directory from the workspace.',
    parameters: obj({ path: str('Path to delete'), recursive: bool('Required to delete non-empty directories') }, ['path']),
    run: async ({ path, recursive }) => ok(await H.fs.remove(path, { recursive })),
  });
  def({
    name: 'fs_move', group: 'Files', risk: 'write',
    description: 'Move or rename a file.',
    parameters: obj({ from: str('Source path'), to: str('Destination path') }, ['from', 'to']),
    run: async ({ from, to }) => ok(await H.fs.move(from, to)),
  });
  def({
    name: 'fs_stat', group: 'Files', risk: 'safe',
    description: 'Get metadata (kind, size, modified) for a path.',
    parameters: obj({ path: str('Path') }, ['path']),
    run: async ({ path }) => ok(await H.fs.stat(path)),
  });
  def({
    name: 'fs_search', group: 'Files', risk: 'safe',
    description: 'Search file contents (grep). Returns matching lines with file and line number.',
    parameters: obj({ query: str('Text or regex to search for'), path: str('Directory to search in (default root)'), regex: bool('Treat query as a regular expression'), caseSensitive: bool('Case sensitive'), glob: str('Only files matching glob, e.g. *.js or src/**/*.py'), maxResults: num('Max results (default 200)') }, ['query']),
    run: async (a) => ok({ hits: await H.fs.search(a) }),
  });
  def({
    name: 'fs_find', group: 'Files', risk: 'safe',
    description: 'Find files by glob pattern, e.g. "**/*.ts" or "*.md".',
    parameters: obj({ glob: str('Glob pattern'), path: str('Directory to search in') }, ['glob']),
    run: async ({ glob, path = '' }) => ok({ files: await H.fs.find(glob, path) }),
  });
  def({
    name: 'fs_upload_from_user', group: 'Files', risk: 'safe',
    description: 'Ask the user to pick one or more files from their computer (outside the workspace). Returns their text contents; PDF, Word, PowerPoint and spreadsheets are converted to text.',
    parameters: obj({ accept: str('Accept filter, e.g. ".csv,.txt" (optional)') }),
    run: ({ accept }) => new Promise((res) => {
      const inp = H.el('input', { type: 'file', multiple: true, accept: accept || '' });
      let done = false; const finish = (v) => { if (!done) { done = true; res(v); } };
      inp.onchange = async () => { const out = []; for (const f of inp.files) { const r = await H.extract.fromFile(f, { maxChars: 100000 }); out.push({ name: f.name, size: f.size, kind: r.kind, content: r.kind === 'text' ? r.content : (r.kind === 'image' ? '(image; attach it in the chat to view it)' : ''), note: r.note }); } finish({ files: out }); };
      inp.oncancel = () => finish({ files: [], cancelled: true, note: 'The user cancelled the file dialog.' });
      // browsers without the cancel event: resolve when focus returns and nothing was chosen
      window.addEventListener('focus', () => setTimeout(() => { if (!inp.files.length) finish({ files: [], cancelled: true, note: 'The user closed the file dialog without choosing a file.' }); }, 800), { once: true });
      inp.click();
    }),
  });
  def({
    name: 'download_file', rerun: 'Download again', group: 'Files', risk: 'write',
    description: 'Offer a file for download to the user\'s Downloads folder (browser download).',
    parameters: obj({ filename: str('File name'), content: str('Text content'), mimeType: str('MIME type (default text/plain)') }, ['filename', 'content']),
    run: async ({ filename, content, mimeType }) => { H.download(filename, content, mimeType || 'text/plain'); return ok({ downloaded: filename }); },
  });

  def({
    name: 'view_image', group: 'Files', risk: 'safe',
    description: 'Look at an image file from the workspace (png, jpg, gif, webp, bmp, svg). The image is shown to you in the next turn as vision input (requires a multimodal model).',
    parameters: obj({ path: str('Image file path in the workspace') }, ['path']),
    run: async ({ path }, ctx) => {
      const file = await H.fs.readFile(path, { binary: true });
      const blob = file instanceof Blob ? file : new Blob([file]);
      const named = Object.assign(blob, { name: path.split('/').pop() });
      const r = /\.svg$/i.test(path) ? { kind: 'image', content: 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(await blob.text()))) } : await H.extract.fromFile(named, { onStatus: ctx?.onStatus });
      if (r.kind !== 'image') throw new Error(r.note || 'Not a decodable image');
      (ctx.images ||= []).push({ name: path, content: r.content });
      return ok({ queued: path, note: 'The image will be shown to you as vision input in the next turn.' + (r.note ? ' ' + r.note : '') });
    },
  });

  /* ===================== CODE EXECUTION ===================== */
  def({
    name: 'run_javascript', group: 'Code', risk: 'write',
    description: 'Run JavaScript in a sandboxed Web Worker (no DOM, no workspace access, network via fetch allowed). Use console.log for output; the value of a final `return` is captured. Async/await supported.',
    parameters: obj({ code: str('JavaScript code (body of an async function; use return to yield a value)'), input: { description: 'Optional JSON input available as `input`' }, timeoutMs: num('Timeout in ms (default 15000)') }, ['code']),
    run: async ({ code, input, timeoutMs }) => ok(await H.runtime.runJS(code, { timeout: timeoutMs || 15000, input })),
  });
  def({
    name: 'run_python', group: 'Code', risk: 'write',
    description: 'Run Python code in the browser via Pyodide (numpy, pandas, etc. available; pure-python packages installable). Output = stdout + value of last expression. No workspace access; pass files via `files`.',
    parameters: obj({ code: str('Python code'), packages: { type: 'array', items: { type: 'string' }, description: 'Packages to load/install, e.g. ["numpy","requests"]' }, files: { type: 'object', description: 'Map filename -> text content to place in the Python working dir', additionalProperties: { type: 'string' } }, timeoutMs: num('Timeout ms (default 60000)') }, ['code']),
    run: async ({ code, packages, files, timeoutMs }, ctx) => ok(await H.runtime.runPython(code, { packages: packages || [], files: files || {}, timeout: timeoutMs || 60000, onStatus: ctx.onStatus })),
  });
  def({
    name: 'run_file', rerun: 'Run again', rerunConfirm: (a) => !/\.html?$/i.test(String(a.path || '')), group: 'Code', risk: 'write',
    description: 'Run a file from the workspace: .js/.mjs (sandboxed worker), .py (Pyodide), .html (preview panel), .json (parse & return), .md/.txt (return contents). Other .py files in the same directory are made importable.',
    parameters: obj({ path: str('Workspace file path'), args: { type: 'array', items: { type: 'string' }, description: 'Arguments (sys.argv for Python, `input.args` for JS)' } }, ['path']),
    run: async ({ path, args = [] }, ctx) => {
      path = String(path).replace(/\\/g, '/');
      const ext = (path.split('.').pop() || '').toLowerCase();
      const code = await H.fs.readFile(path);
      if (ext === 'js' || ext === 'mjs') return ok(await H.runtime.runJS(code, { input: { args } }));
      if (ext === 'py') {
        const dir = path.split('/').slice(0, -1).join('/');
        const files = {};
        for (const e of await H.fs.list(dir)) if (e.kind === 'file' && e.path.endsWith('.py')) files[e.path.split('/').pop()] = await H.fs.readFile(e.path);
        const pre = `import sys\nsys.argv = ${JSON.stringify([path.split('/').pop(), ...args])}\n`;
        return ok(await H.runtime.runPython(pre + code, { files, onStatus: ctx.onStatus }));
      }
      if (ext === 'html' || ext === 'htm') { H.runtime.previewHTML(code, { title: path }); return ok({ previewed: path }); }
      if (ext === 'json') { const j = H.parseArgs(code); if (j.error) throw new Error('Invalid JSON in ' + path + ': ' + j.error); return ok({ parsed: j.value }); }
      return ok({ content: H.clamp(code, 50000) });
    },
  });
  def({
    name: 'render_html', rerun: 'Render again', group: 'Code', risk: 'safe',
    description: 'Render an HTML document (with inline CSS/JS) in the preview panel for the user to see.',
    parameters: obj({ html: str('Complete HTML document'), title: str('Panel title') }, ['html']),
    run: async ({ html, title }) => { H.runtime.previewHTML(html, { title: title || 'Preview' }); return ok({ rendered: true }); },
  });
  def({
    name: 'calculate', group: 'Code', risk: 'safe',
    description: 'Evaluate a math/JavaScript expression safely (no network access), e.g. "Math.sqrt(2)*10" or "(1234*5)/3".',
    parameters: obj({ expression: str('Expression') }, ['expression']),
    run: async ({ expression }) => { const r = await H.runtime.runJS('return (' + expression + ');', { timeout: 3000, network: false }); if (r.error) throw new Error(r.error); return ok({ result: r.result }); },
  });

  /* ===================== WEB ===================== */
  const originOf = (a) => { try { return new URL(String(a?.url || '')).origin; } catch { return null; } };
  def({
    name: 'web_fetch', group: 'Web', risk: 'safe', scope: originOf,
    description: 'Fetch a URL directly from the browser and return readable text (HTML converted to markdown-ish text) or raw body. Sites that do not allow cross-origin requests cannot be fetched unless the user configured a proxy; in that case suggest open_url so the user can read the page themselves.',
    parameters: obj({ url: str('Absolute URL'), raw: bool('Return raw body instead of extracted text'), maxChars: num('Max characters to return (default 20000)') }, ['url']),
    run: async ({ url, raw = false, maxChars = 20000 }) => {
      let text, via = 'direct', status;
      if (!/^https?:\/\//i.test(url)) throw new Error(`url must be an absolute http(s) URL, got "${url}".`);
      try {
        if (H.bridge.has(url)) {   // a logged-in tab of that site is connected: use it (handles sites without CORS and behind login)
          const b = await H.bridge.fetch(url, { headers: { 'Accept': 'text/html,application/json,text/plain,*/*' } });
          status = b.status; via = 'browser session bridge'; const ct = b.headers?.['content-type'] || '';
          text = raw || !/html/i.test(ct) ? (b.body || '') : H.htmlToText(b.body || '', url);
          return ok({ url, status, via, content: H.clamp(text, maxChars) });
        }
        const r = await fetchWithProxy(url, { headers: { 'Accept': 'text/html,application/json,text/plain,*/*' } });
        status = r.status;
        const ct = r.headers.get('content-type') || '';
        const body = await r.text();
        text = raw || !/html/i.test(ct) ? body : H.htmlToText(body, url);
      } catch (e) {
        if (!H.settings.get('jinaFallback')) throw new Error(`Could not fetch ${url} directly from the browser (the site probably does not allow cross-origin requests). No third-party fetch service is enabled (Settings > Security). Suggest open_url so the user can read the page, or ask them to paste the content.`);
        const r = await fetch('https://r.jina.ai/' + url, { headers: { 'Accept': 'text/plain' } });
        if (!r.ok) throw new Error(`Fetch failed directly (${e.message}) and via r.jina.ai (HTTP ${r.status})`);
        text = await r.text(); via = 'r.jina.ai (third-party reader)'; status = r.status;
      }
      return ok({ url, status, via, content: H.clamp(text, maxChars) });
    },
  });
  def({
    name: 'web_search', group: 'Web', risk: 'safe',
    description: 'Search the web using the search provider configured by the user (disabled until configured). Returns result snippets and URLs.',
    parameters: obj({ query: str('Search query'), maxChars: num('Max characters (default 12000)') }, ['query']),
    run: async ({ query, maxChars = 12000 }) => {
      const tpl = H.settings.get('searchTemplate');
      if (!tpl) throw new Error('web_search is disabled: no search provider is configured (Settings > Security & web). Ask the user to configure one, or use open_url to open a search page for them.');
      const url = tpl.replace('{q}', encodeURIComponent(query));
      const headers = { 'Accept': 'application/json, text/plain' };
      const hk = H.settings.get('searchKeyHeader'), hv = H.settings.get('searchKeyValue');
      if (hk && hv) headers[hk] = hv;
      const r = await fetchWithProxy(url, { headers }, { allowProxy: !(hk && hv) });   // a keyed search API is never sent via the proxy
      if (!r.ok) throw new Error(`Search HTTP ${r.status}: ${H.clamp(await r.text(), 500)}`);
      const ct = r.headers.get('content-type') || '';
      let body = await r.text();
      // unwrap DuckDuckGo redirect links and drop favicon images to save tokens
      body = body.replace(/https?:\/\/duckduckgo\.com\/l\/\?uddg=([^&)\s"]+)[^)\s"]*/g, (_, u) => { try { return decodeURIComponent(u); } catch { return u; } }).replace(/!\[[^\]]*\]\([^)]*\)/g, '');
      return ok({ query, content: H.clamp(/json/.test(ct) ? JSON.stringify(H.tryJSON(body, body), null, 1) : body, maxChars) });
    },
  });
  def({
    name: 'http_request', group: 'Web', risk: 'write', scope: originOf,
    // A connected bridge tab would send the request with the user's login cookies: always confirm, whatever the mode.
    mustAsk: (a) => { const o = originOf(a); return o && H.bridge.has(a.url) ? { key: 'http_request@bridge:' + o, note: `This request would be sent through your connected browser tab for ${o}, using your login session there. Approve only if you expect the assistant to act on that site as you.` } : null; },
    description: 'Make an arbitrary HTTP request (call any REST API). Returns status, headers and body (JSON parsed when possible).',
    parameters: obj({
      url: str('Absolute URL'), method: str('HTTP method', { enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] }),
      headers: { type: 'object', description: 'Request headers', additionalProperties: { type: 'string' } },
      body: { description: 'Request body: object (sent as JSON) or string' },
      timeoutMs: num('Timeout ms (default 30000)'),
    }, ['url']),
    run: async ({ url, method = 'GET', headers = {}, body, timeoutMs = 30000 }) => {
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
      const init = { method, headers: { ...headers }, signal: ctl.signal };
      if (body !== undefined && method !== 'GET' && method !== 'HEAD') {
        if (typeof body === 'object') { init.body = JSON.stringify(body); init.headers['Content-Type'] ||= 'application/json'; }
        else init.body = String(body);
      }
      if (!/^https?:\/\//i.test(url)) throw new Error(`url must be an absolute http(s) URL, got "${url}".`);
      try {
        if (H.bridge.has(url)) {
          const b = await H.bridge.fetch(url, { method, headers: init.headers, body: init.body });
          return ok({ status: b.status, ok: b.ok, via: 'browser session bridge', headers: b.headers || {}, body: H.tryJSON(b.body || '', H.clamp(b.body || '', 30000)) });
        }
        const r = await fetchWithProxy(url, init, { allowProxy: false });   // arbitrary API calls are never replayed through a proxy
        const text = await r.text();
        const hdrs = {}; r.headers.forEach((v, k) => hdrs[k] = v);
        return ok({ status: r.status, ok: r.ok, headers: hdrs, body: H.tryJSON(text, H.clamp(text, 30000)) });
      } finally { clearTimeout(t); }
    },
  });
  def({
    name: 'open_url', rerun: 'Open again', group: 'Web', risk: 'write',
    description: 'Open a URL in a new browser tab for the user.',
    parameters: obj({ url: str('URL') }, ['url']),
    run: async ({ url }) => { const w = window.open(url, '_blank', 'noopener'); if (!w) throw new Error('The browser blocked the new tab (popup blocker). Tell the user the URL so they can open it themselves: ' + url); return ok({ opened: url }); },
  });

  /* ===================== DATA ===================== */
  def({
    name: 'json_query', group: 'Data', risk: 'safe',
    description: 'Transform JSON data with a JavaScript expression (no network access). `data` holds the parsed input, e.g. "data.items.filter(i => i.open).map(i => i.id)".',
    parameters: obj({ data: { description: 'JSON value or JSON string' }, expression: str('JavaScript expression over `data`') }, ['data', 'expression']),
    run: async ({ data, expression }) => { const d = typeof data === 'string' ? H.tryJSON(data, data) : data; const r = await H.runtime.runJS(`const data = input; return (${expression});`, { input: d, timeout: 5000, network: false }); if (r.error) throw new Error(r.error); return ok({ result: r.result }); },
  });
  def({
    name: 'regex_extract', group: 'Data', risk: 'safe',
    description: 'Extract all matches of a regex from text.',
    parameters: obj({ text: str('Input text'), pattern: str('Regular expression'), flags: str('Regex flags (default "g")') }, ['text', 'pattern']),
    run: async ({ text, pattern, flags = 'g' }) => { const re = new RegExp(pattern, flags.includes('g') ? flags : flags + 'g'); const out = []; let m; while ((m = re.exec(text)) && out.length < 1000) { out.push(m.length > 1 ? m.slice(1) : m[0]); if (!m[0]) re.lastIndex++; } return ok({ matches: out }); },
  });
  def({
    name: 'csv_parse', group: 'Data', risk: 'safe',
    description: 'Parse CSV/TSV text into an array of row objects (first row = header).',
    parameters: obj({ text: str('CSV text'), delimiter: str('Delimiter (default ",")'), limit: num('Max rows (default 500)') }, ['text']),
    run: async ({ text, delimiter = ',', limit = 500 }) => {
      delimiter = delimiter === '\\t' || delimiter === 'tab' ? '\t' : (delimiter || ',');
      const rows = []; let row = [], cell = '', q = false;
      for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
        else if (c === '"') q = true;
        else if (text.startsWith(delimiter, i)) { row.push(cell); cell = ''; i += delimiter.length - 1; }
        else if (c === '\n') { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = ''; }
        else cell += c;
      }
      if (cell || row.length) { row.push(cell); rows.push(row); }
      const [hdr, ...body] = rows;
      return ok({ columns: hdr, rowCount: body.length, rows: body.slice(0, limit).map(r => Object.fromEntries(hdr.map((h, i) => [h, r[i]]))) });
    },
  });
  def({
    name: 'text_stats', group: 'Data', risk: 'safe',
    description: 'Word/line/char counts and approximate token count of a text.',
    parameters: obj({ text: str('Text') }, ['text']),
    run: async ({ text }) => ok({ chars: text.length, words: (text.match(/\S+/g) || []).length, lines: text.split('\n').length, approxTokens: H.estTokens(text) }),
  });
  def({
    name: 'base64', group: 'Data', risk: 'safe',
    description: 'Encode or decode base64 text.',
    parameters: obj({ text: str('Input'), mode: str('encode or decode', { enum: ['encode', 'decode'] }) }, ['text', 'mode']),
    run: async ({ text, mode }) => ok({ result: mode === 'encode' ? btoa(unescape(encodeURIComponent(text))) : decodeURIComponent(escape(atob(text))) }),
  });
  def({
    name: 'hash_text', group: 'Data', risk: 'safe',
    description: 'Compute SHA-256 / SHA-1 hex digest of text.',
    parameters: obj({ text: str('Input'), algorithm: str('SHA-256 (default), SHA-1, SHA-384, SHA-512') }, ['text']),
    run: async ({ text, algorithm = 'SHA-256' }) => { const b = await crypto.subtle.digest(algorithm, new TextEncoder().encode(text)); return ok({ algorithm, hex: [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('') }); },
  });

  /* ===================== MEMORY (persistent notes) ===================== */
  def({
    name: 'memory_save', group: 'Memory', risk: 'safe',
    description: 'Persist a fact/note under a key so it is available in future chats. Overwrites existing key.',
    parameters: obj({ key: str('Short kebab-case key'), value: str('Content to remember'), tags: { type: 'array', items: { type: 'string' } } }, ['key', 'value']),
    run: async ({ key, value, tags }) => { await H.db.memSet(key, value, tags); return ok({ saved: key }); },
  });
  def({
    name: 'memory_get', group: 'Memory', risk: 'safe',
    description: 'Retrieve a memory by key.',
    parameters: obj({ key: str('Key') }, ['key']),
    run: async ({ key }) => ok((await H.db.memGet(key)) || { error: 'not found' }),
  });
  def({
    name: 'memory_list', group: 'Memory', risk: 'safe',
    description: 'List all memories (keys, tags, values), optionally filtered by a substring.',
    parameters: obj({ filter: str('Substring filter on key/value/tags (optional)') }),
    run: async ({ filter }) => { let all = await H.db.memAll(); if (filter) { const f = filter.toLowerCase(); all = all.filter(m => (m.key + ' ' + m.value + ' ' + (m.tags || []).join(' ')).toLowerCase().includes(f)); } return ok({ memories: all }); },
  });
  def({
    name: 'memory_delete', group: 'Memory', risk: 'write',
    description: 'Delete a memory by key.',
    parameters: obj({ key: str('Key') }, ['key']),
    run: async ({ key }) => { await H.db.memDel(key); return ok({ deleted: key }); },
  });

  /* ===================== USER INTERACTION & MISC ===================== */
  def({
    name: 'ask_user', group: 'Interaction', risk: 'safe',
    description: 'Ask the user a clarifying question and wait for their answer. The question appears in the chat; the user answers by clicking a choice or typing in the message box. Optionally offer choices.',
    parameters: obj({ question: str('Question to ask'), choices: { type: 'array', items: { type: 'string' }, description: 'Optional list of choices' } }, ['question']),
    run: ({ question, choices }, ctx) => {
      if (!ctx?.toolMsg) return Promise.resolve({ answer: null, cancelled: true, note: 'ask_user is only available in the main chat.' });
      return H.agent.askUser(ctx.chatId, ctx.toolMsg, question, choices, ctx.signal);
    },
  });
  def({
    name: 'notify_user', rerun: 'Show again', group: 'Interaction', risk: 'safe',
    description: 'Show a short notification toast to the user (does not interrupt).',
    parameters: obj({ message: str('Message'), kind: str('info | success | warn | error', { enum: ['info', 'success', 'warn', 'error'] }) }, ['message']),
    run: async ({ message, kind = 'info' }) => { H.toast(message, kind, 6000); return ok({ shown: true }); },
  });
  def({
    name: 'clipboard_write', rerun: 'Copy again', group: 'Interaction', risk: 'write',
    description: 'Copy text to the user\'s clipboard.',
    parameters: obj({ text: str('Text') }, ['text']),
    run: async ({ text }) => { if (!navigator.clipboard) throw new Error('Clipboard API unavailable (needs a secure context: https or localhost).'); await navigator.clipboard.writeText(String(text)); return ok({ copied: String(text).length }); },
  });
  def({
    name: 'get_datetime', group: 'Utility', risk: 'safe',
    description: 'Get the current date/time, timezone and locale of the user.',
    parameters: obj({}),
    run: async () => { const d = new Date(); return ok({ iso: d.toISOString(), local: d.toString(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, locale: navigator.language, epochMs: d.getTime() }); },
  });
  def({
    name: 'sleep', group: 'Utility', risk: 'safe',
    description: 'Wait for N milliseconds (max 60000), e.g. before polling an API again.',
    parameters: obj({ ms: num('Milliseconds') }, ['ms']),
    run: async ({ ms }) => { await H.sleep(Math.min(60000, ms)); return ok({ slept: ms }); },
  });
  def({
    name: 'browser_info', group: 'Utility', risk: 'safe',
    description: 'Return information about the runtime environment (browser, capabilities, workspace, loaded plugins).',
    parameters: obj({}),
    run: async () => ok({ userAgent: navigator.userAgent, fsAccess: H.fs.supported(), workspace: H.fs.name() || null, online: navigator.onLine, pyodideLoaded: H.runtime.pyodideLoaded(), plugins: H.plugins.list().map(p => ({ id: p.id, enabled: p.enabled, kind: p.kind })), skills: H.skills.list().map(s => s.name) }),
  });

  /* ===================== SKILLS ===================== */
  def({
    name: 'use_skill', group: 'Skills', risk: 'safe',
    description: 'Load a skill (a reusable instruction set / workflow) by name and return its full instructions. Call this when a user request matches an available skill.',
    parameters: obj({ name: str('Skill name') }, ['name']),
    run: async ({ name }) => { const s = H.skills.get(name); if (!s) throw new Error('Unknown skill: ' + name + '. Available: ' + H.skills.list().map(x => x.name).join(', ')); return ok({ name: s.name, description: s.description, instructions: s.content }); },
  });
  def({
    name: 'list_skills', group: 'Skills', risk: 'safe',
    description: 'List available skills with descriptions.',
    parameters: obj({}),
    run: async () => ok({ skills: H.skills.list().map(s => ({ name: s.name, description: s.description })) }),
  });

  /* ===================== SUB-AGENT ===================== */
  def({
    name: 'run_subagent', group: 'Agent', risk: 'write',
    description: 'Delegate a self-contained task to a fresh sub-agent (same model, same tools) with its own context window. Returns its final answer. Useful for long research or big file exploration.',
    parameters: obj({ task: str('Complete task description with all needed context'), maxIterations: num('Max tool iterations (default 15)') }, ['task']),
    run: async ({ task, maxIterations = 15 }, ctx) => {
      const res = await H.agent.runOnce({ task, maxIterations, onStatus: ctx.onStatus, signal: ctx.signal });
      return ok({ answer: res });
    },
  });

  /* ---------- registry API ---------- */
  function all() { return [...registry.values(), ...H.plugins.tools()]; }
  let pluginIndex = null, pluginIndexFor = null;
  function get(name) {
    const r = registry.get(name); if (r) return r;
    const list = H.plugins.tools();
    if (pluginIndexFor !== list) { pluginIndex = new Map(list.map(t => [t.name, t])); pluginIndexFor = list; }   // re-index only when the list object changes
    return pluginIndex.get(name);
  }
  function enabled() { const dis = new Set(H.settings.get('disabledTools') || []); return all().filter(t => !dis.has(t.name) && H.perms.policyFor(t) !== 'deny' && (!t.plugin || H.plugins.get(t.plugin)?.enabled)); }
  function openaiSpecs() { return enabled().map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters || { type: 'object', properties: {} } } })); }
  function groups() { const g = {}; for (const t of all()) (g[t.group || 'Other'] ||= []).push(t); return g; }
  return { def, all, get, enabled, openaiSpecs, groups, fetchWithProxy };
})();
