/* The workspace seen as a codebase: ignore rules, a cached file index, content cache, grep,
   language-aware outlines, symbol lookup, import graph, project overview and change snapshots. */
H.code = (() => {

  /* ============================ languages ============================ */
  const EXT = {
    js: 'js', mjs: 'js', cjs: 'js', jsx: 'js', ts: 'ts', tsx: 'ts', mts: 'ts', cts: 'ts',
    py: 'py', pyi: 'py', rb: 'rb', php: 'php', go: 'go', rs: 'rs', java: 'java', kt: 'kotlin', kts: 'kotlin',
    cs: 'csharp', swift: 'swift', c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp',
    m: 'objc', mm: 'objc', scala: 'scala', dart: 'dart', lua: 'lua', pl: 'perl', r: 'r', jl: 'julia',
    sh: 'shell', bash: 'shell', zsh: 'shell', ps1: 'powershell', sql: 'sql',
    css: 'css', scss: 'css', sass: 'css', less: 'css', html: 'html', htm: 'html', vue: 'vue', svelte: 'svelte',
    md: 'markdown', markdown: 'markdown', json: 'json', yml: 'yaml', yaml: 'yaml', toml: 'toml', xml: 'xml',
    tf: 'terraform', gradle: 'gradle', ini: 'ini', cfg: 'ini', env: 'ini', txt: 'text', csv: 'text',
  };
  const langOf = (path) => EXT[(path.split('.').pop() || '').toLowerCase()] || (/(^|\/)(Dockerfile|Makefile|Rakefile|Gemfile)$/i.test(path) ? 'text' : '');

  const W = '[A-Za-z_$][\\w$]*';
  /* def rules: [regex, kind, capture group holding the name] */
  const RULES = {
    js: {
      defs: [
        [new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\s*\\*?\\s*(${W})`), 'function', 1],
        [new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?(?:abstract\\s+)?class\\s+(${W})`), 'class', 1],
        [new RegExp(`^\\s*(?:export\\s+)?(?:const|let|var)\\s+(${W})\\s*=\\s*(?:async\\s*)?(?:function\\b|\\([^)]*\\)\\s*=>|${W}\\s*=>)`), 'function', 1],
        [new RegExp(`^\\s*(?:export\\s+)?(?:const|let|var)\\s+(${W})\\s*=`), 'const', 1],
        [new RegExp(`^([A-Za-z_$][\\w$.]*)\\s*=\\s*\\(?\\s*(?:async\\s*)?\\(\\s*\\)\\s*=>`), 'module', 1],
        [new RegExp(`^\\s*(?:export\\s+)?(?:declare\\s+)?(?:interface|type|enum)\\s+(${W})`), 'type', 1],
        [new RegExp(`^\\s{2,}(?:static\\s+)?(?:async\\s+)?(?:get\\s+|set\\s+)?(${W})\\s*\\([^)]*\\)\\s*\\{`), 'method', 1],
        [new RegExp(`^\\s{2,}(${W})\\s*:\\s*(?:async\\s*)?(?:function\\b|\\([^)]*\\)\\s*=>)`), 'method', 1],
      ],
      imports: [/^\s*import\s+[^'"]*['"]([^'"]+)['"]/, /^\s*export\s+[^'"]*from\s+['"]([^'"]+)['"]/, /require\(\s*['"]([^'"]+)['"]\s*\)/, /import\(\s*['"]([^'"]+)['"]\s*\)/],
      skipWords: new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'constructor', 'do', 'else']),
    },
    py: {
      defs: [
        [/^(\s*)(?:async\s+)?def\s+(\w+)/, 'function', 2],
        [/^(\s*)class\s+(\w+)/, 'class', 2],
        [/^(\w+)\s*(?::[^=]+)?=\s*[^=]/, 'const', 1],
      ],
      imports: [/^\s*from\s+([\w.]+)\s+import\s/, /^\s*import\s+([\w.]+)/],
    },
    go: {
      defs: [[/^func\s+(?:\([^)]*\)\s*)?(\w+)/, 'function', 1], [/^type\s+(\w+)\s+(?:struct|interface)/, 'type', 1], [/^type\s+(\w+)/, 'type', 1], [/^(?:var|const)\s+(\w+)/, 'const', 1]],
      imports: [/^\s*(?:_\s+|\w+\s+)?"([^"]+)"\s*$/, /^\s*import\s+(?:\w+\s+)?"([^"]+)"/],
    },
    rs: {
      defs: [[/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+(\w+)/, 'function', 1], [/^\s*(?:pub(?:\([^)]*\))?\s+)?(struct|enum|trait|union)\s+(\w+)/, 'type', 2], [/^\s*impl(?:<[^>]*>)?\s+(?:\w+\s+for\s+)?([\w:<>]+)/, 'impl', 1], [/^\s*(?:pub\s+)?mod\s+(\w+)/, 'module', 1], [/^\s*macro_rules!\s*(\w+)/, 'macro', 1]],
      imports: [/^\s*(?:pub\s+)?use\s+([\w:{}*,\s]+);/, /^\s*mod\s+(\w+);/],
    },
    java: {
      defs: [[/^\s*(?:public|private|protected|static|final|abstract|sealed|\s)*(class|interface|enum|record)\s+(\w+)/, 'class', 2], [/^\s*(?:public|private|protected|static|final|abstract|synchronized|native|default|\s)+[\w<>\[\],.?\s]+\s+(\w+)\s*\([^;]*\)\s*(?:throws [\w,\s.]+)?\{/, 'method', 1]],
      imports: [/^\s*import\s+(?:static\s+)?([\w.*]+);/],
    },
    kotlin: {
      defs: [[/^\s*(?:public|private|protected|internal|open|abstract|sealed|data|inner|\s)*(?:class|interface|object|enum class)\s+(\w+)/, 'class', 1], [/^\s*(?:public|private|protected|internal|open|override|suspend|inline|\s)*fun\s+(?:<[^>]*>\s*)?(?:[\w.<>]+\.)?(\w+)/, 'function', 1], [/^\s*(?:va[lr])\s+(\w+)/, 'const', 1]],
      imports: [/^\s*import\s+([\w.*]+)/],
    },
    csharp: {
      defs: [[/^\s*(?:public|private|protected|internal|static|sealed|abstract|partial|\s)*(?:class|interface|struct|enum|record)\s+(\w+)/, 'class', 1], [/^\s*(?:public|private|protected|internal|static|virtual|override|async|sealed|\s)+[\w<>\[\],.?\s]+\s+(\w+)\s*\([^;]*\)\s*\{?\s*$/, 'method', 1]],
      imports: [/^\s*using\s+(?:static\s+)?([\w.]+);/],
    },
    rb: { defs: [[/^\s*(?:def\s+)([\w.?!=]+)/, 'function', 1], [/^\s*class\s+([\w:]+)/, 'class', 1], [/^\s*module\s+([\w:]+)/, 'module', 1]], imports: [/^\s*require(?:_relative)?\s+['"]([^'"]+)['"]/] },
    php: { defs: [[/^\s*(?:abstract\s+|final\s+)?(?:class|interface|trait|enum)\s+(\w+)/, 'class', 1], [/^\s*(?:public|private|protected|static|abstract|final|\s)*function\s+(\w+)/, 'function', 1], [/^\s*const\s+(\w+)/, 'const', 1]], imports: [/^\s*use\s+([\w\\]+)/, /require(?:_once)?\s*\(?\s*['"]([^'"]+)['"]/] },
    swift: { defs: [[/^\s*(?:public|private|internal|open|fileprivate|\s)*(?:static\s+|class\s+)?func\s+(\w+)/, 'function', 1], [/^\s*(?:public|private|internal|open|final|\s)*(?:class|struct|enum|protocol|extension|actor)\s+(\w+)/, 'class', 1], [/^\s*(?:public|private|\s)*(?:let|var)\s+(\w+)/, 'const', 1]], imports: [/^\s*import\s+(\w+)/] },
    c: { defs: [[/^\s*(?:static\s+|inline\s+|extern\s+)*[\w*\s]+\**(\w+)\s*\([^;]*\)\s*\{?\s*$/, 'function', 1], [/^\s*(?:typedef\s+)?(?:struct|enum|union)\s+(\w+)/, 'type', 1], [/^\s*#define\s+(\w+)/, 'macro', 1]], imports: [/^\s*#include\s*[<"]([^>"]+)[>"]/] },
    sql: { defs: [[/^\s*create\s+(?:or\s+replace\s+)?(?:table|view|function|procedure|index|trigger)\s+(?:if\s+not\s+exists\s+)?([\w."`]+)/i, 'object', 1]], imports: [] },
    shell: { defs: [[/^\s*(?:function\s+)?([\w-]+)\s*\(\)\s*\{/, 'function', 1], [/^\s*([A-Z_][A-Z0-9_]*)=/, 'const', 1]], imports: [/^\s*(?:source|\.)\s+(\S+)/] },
    css: { defs: [[/^\s*@(?:mixin|function)\s+([\w-]+)/, 'mixin', 1], [/^([.#][\w-][^{,]*)\s*\{/, 'rule', 1]], imports: [/@(?:import|use)\s+['"]([^'"]+)['"]/] },
    markdown: { defs: [[/^(#{1,6})\s+(.+)$/, 'heading', 2]], imports: [] },
  };
  RULES.ts = RULES.js; RULES.vue = RULES.js; RULES.svelte = RULES.js; RULES.cpp = RULES.c; RULES.objc = RULES.c;
  RULES.scala = RULES.java; RULES.dart = RULES.java; RULES.powershell = RULES.shell;

  /* ============================ ignore rules ============================ */
  const DEFAULT_SKIP = ['node_modules', '.git', 'dist', 'build', '.venv', 'venv', '__pycache__', '.next', '.nuxt', 'target', 'vendor', '.gradle', '.idea', '.vscode', 'coverage', '.pytest_cache', '.mypy_cache', '.tox', 'bin', 'obj', '.svelte-kit', '.terraform'];
  const NOISY_FILES = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Cargo\.lock|composer\.lock|Gemfile\.lock|go\.sum|\.DS_Store)$/i;
  const BINARY_EXT = /\.(png|jpe?g|gif|webp|bmp|ico|svgz|pdf|zip|gz|bz2|xz|tar|7z|rar|exe|dll|so|dylib|a|o|lib|woff2?|eot|ttf|otf|mp[34]|m4a|wav|ogg|mov|avi|mkv|webm|bin|dat|class|pyc|pyo|wasm|db|sqlite3?|jar|war|iso|dmg|psd|ai|heic|avif)$/i;
  const MINIFIED = /\.(min\.js|min\.css|bundle\.js|map)$/i;

  /** one .gitignore file compiled into matchers, relative to the directory it sits in */
  function compile(content, base) {
    const rules = [];
    for (let line of String(content).split('\n')) {
      line = line.replace(/\r$/, '');
      if (!line.trim() || line.trimStart().startsWith('#')) continue;
      let neg = false, pat = line.trim();
      if (pat.startsWith('!')) { neg = true; pat = pat.slice(1); }
      pat = pat.replace(/\\ /g, ' ');
      let dirOnly = false;
      if (pat.endsWith('/')) { dirOnly = true; pat = pat.slice(0, -1); }
      if (pat.startsWith('**/')) pat = pat.slice(3);          // "**/x" is just "x" anywhere
      const anchored = pat.includes('/');
      if (pat.startsWith('/')) pat = pat.slice(1);
      let rx = '';
      for (let i = 0; i < pat.length; i++) {
        const c = pat[i];
        if (c === '*' && pat[i + 1] === '*') {
          if (pat[i + 2] === '/') { rx += '(?:.*/)?'; i += 2; } else { rx += '.*'; i += 1; }   // "a/**/b" also matches "a/b"
        } else if (c === '*') rx += '[^/]*';
        else if (c === '?') rx += '[^/]';
        else rx += /[.+^${}()|[\]\\]/.test(c) ? '\\' + c : c;
      }
      const body = anchored ? '^' + rx : '(^|.*/)' + rx;
      rules.push({ re: new RegExp(body + '($|/)'), neg, dirOnly, base });
    }
    return rules;
  }
  function ignoredWith(rules, path, isDir) {
    let hit = false;
    for (const r of rules) {
      if (r.base && !(path === r.base || path.startsWith(r.base + '/'))) continue;
      const rel = r.base ? path.slice(r.base.length + 1) : path;
      if (r.dirOnly && !isDir && !r.re.test(rel + '/')) continue;
      if (r.re.test(rel)) hit = !r.neg;
    }
    return hit;
  }
  /** does this .gitignore text ignore this path? (used by the tests, and to explain an ignored file) */
  const matchesIgnore = (gitignoreText, path, isDir = false) => ignoredWith(compile(gitignoreText, ''), path, isDir);

  /** is this indexed file worth grepping? (not binary, not a bundle, not a lockfile, not huge) */
  const searchable = (f, { includeNoisy = false } = {}) =>
    !BINARY_EXT.test(f.path) && !MINIFIED.test(f.path) && (includeNoisy || !NOISY_FILES.test(f.path)) && f.size < 2_000_000;

  /* ============================ outlines (pure: text in, symbols out) ============================ */
  function outlineText(text, lang, path) {
    const rules = RULES[lang];
    const lines = text.split('\n');
    const symbols = [], imports = [];
    if (!rules) return { symbols, imports, lines: lines.length, note: `No outline rules for ${lang || 'this file type'}; showing imports only.` };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.length > 500) continue;
      for (const re of rules.imports) { const m = line.match(re); if (m && m[1]) { imports.push({ line: i + 1, module: m[1].trim() }); break; } }
      for (const [re, kind, g] of rules.defs) {
        const m = line.match(re);
        if (!m || !m[g]) continue;
        const name = m[g].trim();
        if (rules.skipWords?.has(name)) break;
        const indent = (line.match(/^\s*/) || [''])[0].length;
        if (kind === 'const' && indent > 2) break;   // a local variable inside a function is not part of the outline
        symbols.push({ kind: kind === 'heading' ? `h${m[1].length}` : kind, name, line: i + 1, indent, signature: H.clamp(line.trim(), 200) });
        break;
      }
    }
    return { symbols, imports, lines: lines.length };
  }

  /* ============================ one open folder ============================ */
  /* Everything below belongs to one folder: its ignore rules, file index and content cache. An instance is kept per
     folder the user has opened, so switching chats back to a project does not rebuild its index. Paths inside an
     instance are relative to that folder's root, which is what the file tools expect. */
  function make(root) {

    let ignoreRules = [];            // compiled rules from every .gitignore found, root-first
    const ignoredBy = (path, isDir) => ignoredWith(ignoreRules, path, isDir);

    /* ============================ file index ============================ */
    let generation = 0, idx = null, idxAt = 0, idxGen = -1;
    const INDEX_TTL = 60000;
    const bump = () => { generation++; contentCache.clear(); };

    async function readIgnoreFiles() {
      ignoreRules = [];
      const add = async (path, base) => { try { ignoreRules.push(...compile(await H.fs.readFile(path), base)); } catch { } };
      if (H.settings.get('respectGitignore') !== false) {
        await add('.gitignore', '');
        await add('.git/info/exclude', '');
      }
    }

    /** { files: [{path,size,mtime,lang}], dirs: [{path,files}], truncated, usedGitignore } */
    async function index({ refresh = false } = {}) {
      if (!H.fs.hasRoot()) throw new Error('No workspace folder is open. Ask the user to click the folder button under the message box and pick the project folder; code and file tools work only inside a folder this chat has open.');
      if (!refresh && idx && idxGen === generation && Date.now() - idxAt < INDEX_TTL) return idx;
      await readIgnoreFiles();
      const usedGitignore = ignoreRules.length > 0;
      const max = H.settings.get('maxIndexFiles') || 20000;
      const files = [], dirs = new Map();
      let truncated = false;
      /* with a .gitignore the repository's own rules decide; without one, fall back to the usual noise list */
      const ALWAYS = ['.git', 'node_modules'];
      const skipDir = (name, path) => ALWAYS.includes(name) || (usedGitignore ? ignoredBy(path, true) : DEFAULT_SKIP.includes(name));
      let entries = await H.fs.list('', { recursive: true, maxEntries: max + 1, skipDir });
      if (entries.length > max) { entries = entries.slice(0, max); truncated = true; }
      for (const e of entries) {
        if (e.kind === 'directory') { dirs.set(e.path, 0); continue; }
        if (usedGitignore && ignoredBy(e.path, false)) continue;
        files.push({ path: e.path, size: e.size || 0, mtime: e.modified || 0, lang: langOf(e.path) });
        const d = e.path.includes('/') ? e.path.slice(0, e.path.lastIndexOf('/')) : '';
        dirs.set(d, (dirs.get(d) || 0) + 1);
      }
      idx = { files, dirs: [...dirs].map(([path, n]) => ({ path, files: n })), truncated, usedGitignore, at: Date.now() };
      idxAt = Date.now(); idxGen = generation;
      return idx;
    }

    /* ============================ content cache ============================ */
    const contentCache = new Map();   // path -> { key, text }
    let cacheBytes = 0;
    const MAX_CACHE = 8 * 1024 * 1024;
    async function read(path, meta) {
      const key = meta ? `${meta.size}:${meta.mtime}` : '';
      const hit = contentCache.get(path);
      if (hit && (!key || hit.key === key)) return hit.text;
      const text = (await H.fs.readFile(path)).replace(/\r\n/g, '\n');
      if (text.length < 1_000_000) {
        if (cacheBytes > MAX_CACHE) { contentCache.clear(); cacheBytes = 0; }
        contentCache.set(path, { key, text }); cacheBytes += text.length;
      }
      return text;
    }

    /* ============================ grep ============================ */
    async function search({ query, path = '', regex = false, caseSensitive = false, glob = '', exclude = '', maxResults = 100, maxPerFile = 20, contextLines = 0, filesOnly = false, includeNoisy = false, refresh = false, signal = null }) {
      const { files, truncated: idxTrunc } = await index({ refresh });
      const base = String(path || '').replace(/^\.?\/+/, '').replace(/\/+$/, '');
      const pool = files.filter(f => (!base || f.path === base || f.path.startsWith(base + '/'))
        && (!glob || H.fs.globMatch(glob, f.path))
        && (!exclude || !H.fs.globMatch(exclude, f.path))
        && searchable(f, { includeNoisy }));
      let re;
      /* a model-written pattern runs here on the UI thread: H.safeRegex refuses the shapes that backtrack forever */
      const src = regex ? H.safeRegex(query) : String(query).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      try { re = new RegExp(src, caseSensitive ? '' : 'i'); }
      catch (e) { throw new Error(`Invalid regular expression: ${e.message}`); }
      const out = []; let total = 0, scanned = 0, truncated = false, cancelled = false;
      for (const f of pool) {
        if (out.length >= maxResults) { truncated = true; break; }
        if (signal?.aborted) { cancelled = true; break; }   // Stop reaches a long sweep between files
        let text; try { text = await read(f.path, f); } catch { continue; }
        scanned++;
        if (!re.test(text)) continue;
        if (filesOnly) { out.push({ file: f.path }); total++; continue; }
        const lines = text.split('\n');
        const matches = [];
        for (let i = 0; i < lines.length && matches.length < maxPerFile; i++) {
          if (!re.test(lines[i])) continue;
          total++;
          const m = { line: i + 1, text: H.clamp(lines[i].trim(), 400) };
          if (contextLines > 0) {
            m.before = lines.slice(Math.max(0, i - contextLines), i).map(l => H.clamp(l, 300));
            m.after = lines.slice(i + 1, i + 1 + contextLines).map(l => H.clamp(l, 300));
          }
          matches.push(m);
        }
        if (matches.length) out.push({ file: f.path, count: matches.length, matches });
      }
      return {
        query, files: out, totalMatches: total, filesScanned: scanned, filesInScope: pool.length,
        truncated: truncated || idxTrunc, cancelled: cancelled || undefined,
        note: cancelled ? 'Cancelled by the user (Stop) part-way through the search.' : truncated ? `Stopped at ${maxResults} files with matches; narrow with path/glob or raise maxResults.` : undefined,
      };
    }
    async function find(glob, path = '', { refresh = false } = {}) {
      const { files } = await index({ refresh });
      const base = String(path || '').replace(/^\.?\/+/, '').replace(/\/+$/, '');
      return files.filter(f => (!base || f.path.startsWith(base + '/')) && H.fs.globMatch(glob, f.path)).map(f => f.path);
    }

    /* ============================ outline / symbols / imports ============================ */
    async function outline(path, { maxSymbols = 400 } = {}) {
      const lang = langOf(path);
      const text = await read(path);
      const o = outlineText(text, lang, path);
      return { path, language: lang || 'unknown', lines: o.lines, symbolCount: o.symbols.length, symbols: o.symbols.slice(0, maxSymbols), imports: o.imports.slice(0, 100), note: o.note || (o.symbols.length > maxSymbols ? `Showing the first ${maxSymbols} of ${o.symbols.length} symbols.` : undefined) };
    }
    async function outlineGlob(glob, path = '', { maxFiles = 40 } = {}) {
      const paths = (await find(glob, path)).filter(p => !BINARY_EXT.test(p)).slice(0, maxFiles);
      const out = [];
      for (const p of paths) { try { out.push(await outline(p, { maxSymbols: 60 })); } catch (e) { out.push({ path: p, error: e.message }); } }
      return { glob, files: out.length, outlines: out };
    }

    /** definitions and references of a symbol across the workspace */
    async function symbol(name, { path = '', maxFiles = 60, refresh = false } = {}) {
      if (!/^[\w$.:-]{2,}$/.test(String(name))) throw new Error('symbol must be an identifier (letters, digits, _ $ . : -), at least 2 characters.');
      const short = String(name).split(/[.:]/).pop();
      const res = await search({ query: `\\b${short.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, regex: true, caseSensitive: true, path, maxResults: maxFiles, maxPerFile: 40, refresh });
      const definitions = [], references = [];
      for (const f of res.files) {
        const lang = langOf(f.file);
        const rules = RULES[lang];
        let text = null;
        for (const m of f.matches) {
          let isDef = false;
          if (rules) {
            for (const [re, kind, g] of rules.defs) {
              const mm = m.text.match(re);
              if (mm && mm[g] && mm[g].trim() === short) { isDef = { kind }; break; }
            }
          }
          if (isDef) {
            if (text === null) { try { text = (await read(f.file)).split('\n'); } catch { text = []; } }
            definitions.push({ file: f.file, line: m.line, kind: isDef.kind, signature: m.text, context: text.slice(Math.max(0, m.line - 1), m.line + 4).map(l => H.clamp(l, 200)) });
          } else references.push({ file: f.file, line: m.line, text: m.text });
        }
      }
      const byFile = new Map();
      for (const r of references) { const e = byFile.get(r.file) || { file: r.file, count: 0, lines: [] }; e.count++; if (e.lines.length < 8) e.lines.push({ line: r.line, text: r.text }); byFile.set(r.file, e); }
      return {
        symbol: name, definitions, definitionCount: definitions.length,
        references: [...byFile.values()].sort((a, b) => b.count - a.count), referenceCount: references.length,
        filesScanned: res.filesScanned, truncated: res.truncated,
        note: definitions.length ? undefined : 'No definition matched the language patterns; it may be defined dynamically, come from a dependency, or use a syntax the outline rules do not cover.',
      };
    }

    /** resolve an import specifier to a workspace path where possible */
    function resolveImport(spec, fromPath, fileSet) {
      const dir = fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/')) : '';
      const cands = [];
      if (spec.startsWith('.')) {
        const joined = (dir ? dir + '/' : '') + spec;
        const parts = []; for (const p of joined.split('/')) { if (p === '.' || p === '') continue; if (p === '..') parts.pop(); else parts.push(p); }
        const base = parts.join('/');
        cands.push(base);
        for (const e of ['.js', '.ts', '.tsx', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rb', '.php', '.css', '.scss', '.vue', '.svelte', '.json']) cands.push(base + e);
        for (const e of ['/index.js', '/index.ts', '/index.tsx', '/__init__.py', '/mod.rs']) cands.push(base + e);
      } else if (/^[\w.]+$/.test(spec) && spec.includes('.')) {
        const base = spec.replace(/\./g, '/');   // python / java style
        cands.push(base + '.py', base + '/__init__.py', base + '.java', base + '.kt');
      } else {
        cands.push(spec, spec + '.js', spec + '.ts', 'src/' + spec, 'src/' + spec + '.js', 'src/' + spec + '.ts');
      }
      for (const c of cands) if (fileSet.has(c)) return c;
      return null;
    }
    async function deps(path, { reverse = true, maxFiles = 3000 } = {}) {
      const { files } = await index();
      const fileSet = new Set(files.map(f => f.path));
      if (!fileSet.has(path)) throw new Error(`"${path}" is not in the workspace index. Use fs_find to locate it (the index skips ignored and binary files).`);
      const o = await outline(path);
      const imports = o.imports.map(i => ({ ...i, resolved: resolveImport(i.module, path, fileSet) }));
      const out = { path, language: o.language, imports, external: imports.filter(i => !i.resolved).map(i => i.module) };
      if (reverse) {
        const lang = langOf(path);
        const family = new Set(Object.entries(EXT).filter(([, l]) => RULES[l] === RULES[lang]).map(([e]) => e));
        const importers = [];
        let scanned = 0;
        for (const f of files) {
          if (f.path === path || !family.has((f.path.split('.').pop() || '').toLowerCase()) || !searchable(f)) continue;
          if (scanned++ > maxFiles) { out.truncated = true; break; }
          let text; try { text = await read(f.path, f); } catch { continue; }
          if (!text.includes(path.split('/').pop().replace(/\.[^.]+$/, ''))) continue;   // cheap pre-filter
          const oo = outlineText(text, langOf(f.path), f.path);
          for (const i of oo.imports) if (resolveImport(i.module, f.path, fileSet) === path) { importers.push({ file: f.path, line: i.line, module: i.module }); break; }
        }
        out.importedBy = importers; out.importedByCount = importers.length;
      }
      return out;
    }

    /* ============================ project overview ============================ */
    const MANIFESTS = ['package.json', 'pyproject.toml', 'requirements.txt', 'setup.py', 'go.mod', 'Cargo.toml', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'Gemfile', 'composer.json', 'Makefile', 'Dockerfile', 'docker-compose.yml', 'CMakeLists.txt', 'deno.json', 'pubspec.yaml'];
    const CONTEXT_FILES = ['AGENTS.md', 'CLAUDE.md', '.harness/context.md', 'HARNESS.md'];
    const DOC_FILES = ['README.md', 'README.rst', 'README.txt', 'readme.md', 'CONTRIBUTING.md'];

    async function contextFile() {
      if (H.settings.get('projectContextFile') === false) return null;
      for (const name of CONTEXT_FILES) {
        try { const t = await H.fs.readFile(name); if (t && t.trim()) return { name, content: H.clamp(t.trim(), 8000) }; } catch { }
      }
      return null;
    }

    async function overview({ maxDirs = 40, readmeChars = 1500, refresh = false } = {}) {
      const { files, dirs, truncated, usedGitignore } = await index({ refresh });
      const byLang = new Map();
      for (const f of files) {
        const l = f.lang || 'other';
        const e = byLang.get(l) || { files: 0, bytes: 0 };
        e.files++; e.bytes += f.size; byLang.set(l, e);
      }
      const languages = [...byLang].filter(([l]) => l && l !== 'other').sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 12)
        .map(([language, v]) => ({ language, files: v.files, kb: Math.round(v.bytes / 1024) }));

      const manifests = {};
      for (const name of MANIFESTS) {
        const f = files.find(x => x.path === name);
        if (!f) continue;
        try {
          const text = await read(name, f);
          if (name === 'package.json') {
            const j = JSON.parse(text);
            manifests[name] = { name: j.name, version: j.version, description: j.description, type: j.type, scripts: j.scripts, dependencies: Object.keys(j.dependencies || {}), devDependencies: Object.keys(j.devDependencies || {}) };
          } else if (name === 'go.mod') manifests[name] = { module: (text.match(/^module\s+(\S+)/m) || [])[1], go: (text.match(/^go\s+(\S+)/m) || [])[1] };
          else if (name === 'Cargo.toml' || name === 'pyproject.toml') manifests[name] = { head: H.clamp(text, 800) };
          else manifests[name] = { head: H.clamp(text, 400) };
        } catch (e) { manifests[name] = { error: e.message }; }
      }

      let readme = null;
      for (const d of DOC_FILES) { const f = files.find(x => x.path === d); if (f) { try { readme = { file: d, head: H.clamp(await read(d, f), readmeChars) }; } catch { } break; } }

      const top = dirs.filter(d => d.path && !d.path.includes('/')).sort((a, b) => b.files - a.files);
      const counts = new Map();
      for (const f of files) { const t = f.path.includes('/') ? f.path.split('/')[0] : '(root)'; counts.set(t, (counts.get(t) || 0) + 1); }
      const structure = [...counts].sort((a, b) => b[1] - a[1]).slice(0, maxDirs).map(([path, n]) => ({ path, files: n }));

      const entryPoints = files.filter(f => /^(src\/)?(index|main|app|server|cli|__main__|Program|Main)\.(js|ts|tsx|jsx|py|go|rs|java|cs|rb|php)$/i.test(f.path) || /^index\.html$/i.test(f.path)).map(f => f.path).slice(0, 12);
      const tests = [...new Set(files.filter(f => /(^|\/)(tests?|__tests__|spec)\//i.test(f.path) || /\.(test|spec)\.[jt]sx?$|_test\.(py|go|rb)$|Test\.java$/i.test(f.path)).map(f => f.path.split('/')[0]))].slice(0, 10);
      const ci = files.filter(f => /^(\.github\/workflows\/|\.gitlab-ci|\.circleci\/|azure-pipelines|Jenkinsfile|\.travis)/i.test(f.path)).map(f => f.path).slice(0, 10);

      let git = null;
      try {
        const d = await H.git.detect();
        if (d.ok) {
          const h = await H.git.head();
          const cfg = await H.git.config();
          git = { repository: true, branch: h.branch, detached: h.detached, head: h.sha ? h.sha.slice(0, 8) : null, remote: cfg['remote.origin.url'] || null, hint: 'Use git_status for changes, git_log for history.' };
        } else git = { repository: false, reason: d.reason === 'gitfile' ? '.git is a file (submodule or linked worktree); history is not readable from here' : 'no .git directory in this folder' };
      } catch (e) { git = { repository: false, reason: e.message }; }

      const ctx = await contextFile();
      return {
        workspace: H.fs.name(),
        fileCount: files.length, truncated, usesGitignore: usedGitignore,
        git, languages, structure, topLevelDirectories: top.slice(0, maxDirs).map(d => d.path),
        entryPoints, testLocations: tests, ci, manifests, readme,
        projectContext: ctx ? { file: ctx.name, note: 'Already included in your system prompt.' } : null,
        largestFiles: [...files].sort((a, b) => b.size - a.size).slice(0, 10).map(f => ({ path: f.path, kb: Math.round(f.size / 1024) })),
      };
    }

    /* ============================ snapshots (change tracking without git) ============================ */
    const SNAP_MAX_FILE = 512 * 1024, SNAP_MAX_TOTAL = 40 * 1024 * 1024;
    const snapKey = () => 'snapshot:' + root;          // the folder's id, so two folders with the same name keep their own baseline

    async function snapshot({ note = '' } = {}) {
      const { files, truncated } = await index({ refresh: true });
      const store = {}; let bytes = 0, skipped = 0;
      for (const f of files) {
        if (BINARY_EXT.test(f.path) || f.size > SNAP_MAX_FILE || bytes > SNAP_MAX_TOTAL) { store[f.path] = { size: f.size, mtime: f.mtime, big: true }; skipped++; continue; }
        let text; try { text = await read(f.path, f); } catch { skipped++; continue; }
        store[f.path] = { size: f.size, mtime: f.mtime, text };
        bytes += text.length;
      }
      const rec = { taken: Date.now(), note, workspace: H.fs.name(), files: store, fileCount: Object.keys(store).length, skipped, truncated };
      await H.db.kvSet(snapKey(), rec);
      return { taken: new Date(rec.taken).toISOString(), files: rec.fileCount, skipped, workspace: rec.workspace, truncated };
    }
    const getSnapshot = () => H.db.kvGet(snapKey());

    async function changes({ context = 3, paths = null, statOnly = false } = {}) {
      const snap = await getSnapshot();
      if (!snap) return { baseline: null, note: 'No baseline snapshot exists for this workspace yet. Call workspace_snapshot to record one; after that this tool reports every file added, changed or deleted since then.' };
      const { files } = await index({ refresh: true });
      const now = new Map(files.map(f => [f.path, f]));
      const want = (p) => !paths || paths.some(x => p === x || p.startsWith(String(x).replace(/\/$/, '') + '/'));
      const out = [];
      for (const [path, old] of Object.entries(snap.files)) {
        if (!want(path)) continue;
        const cur = now.get(path);
        if (!cur) { out.push({ path, status: 'deleted', ...(statOnly || old.big ? {} : { patch: H.diff.unified(old.text, null, { path, context }) }) }); continue; }
        if (old.big || cur.size !== old.size || cur.mtime !== old.mtime) {
          if (old.big) { if (cur.size !== old.size) out.push({ path, status: 'modified', note: 'binary or very large file: size changed' }); continue; }
          let text; try { text = await read(path, cur); } catch { continue; }
          if (text === old.text) continue;
          const s = H.diff.stat(old.text, text);
          out.push({ path, status: 'modified', added: s.added, removed: s.removed, ...(statOnly ? {} : { patch: H.diff.unified(old.text, text, { path, context }) }) });
        }
      }
      for (const f of files) {
        if (snap.files[f.path] || !want(f.path)) continue;
        if (BINARY_EXT.test(f.path)) { out.push({ path: f.path, status: 'added', note: 'binary file' }); continue; }
        let text; try { text = await read(f.path, f); } catch { continue; }
        out.push({ path: f.path, status: 'added', added: text.split('\n').length, removed: 0, ...(statOnly ? {} : { patch: H.diff.unified(null, text, { path: f.path, context }) }) });
      }
      return { baseline: new Date(snap.taken).toISOString(), note: snap.note || undefined, changed: out.length, files: out.sort((a, b) => a.path.localeCompare(b.path)) };
    }

    return {
      generation: () => generation, bump, index, read, search, find, outline, outlineGlob, symbol, deps,
      overview, contextFile, snapshot, getSnapshot, snapKey, changes, ignoredBy,
    };
  }

  /* One instance per folder, created on first use and kept while that folder stays in the registry: coming back to
     a project an hour later finds its index and caches intact. Everything goes through the folder that is open. */
  /* Kept across folder switches, but not without end: each instance carries a file index and up to 8 MB of file
     contents, so the least recently used ones are dropped. */
  const inst = new Map();
  const MAX_FOLDERS = 4;
  const of = () => {
    const id = H.fs.folder()?.id || 'none';
    if (inst.has(id)) { const i = inst.get(id); inst.delete(id); inst.set(id, i); return i; }   // Map keeps insertion order
    inst.set(id, make(id));
    while (inst.size > MAX_FOLDERS) inst.delete(inst.keys().next().value);
    return inst.get(id);
  };

  /* ============================ system prompt ============================ */
  let contextCache = null, contextFor = null;
  async function refreshContext() {
    const id = H.fs.folder()?.id || 'none';
    const movedFolder = id !== contextFor;         // a different project with an AGENTS.md is still worth announcing
    contextFor = id;
    const prev = contextCache;
    contextCache = await of().contextFile();
    if (contextCache && (movedFolder || !prev || prev.name !== contextCache.name)) H.toast(`Loaded ${contextCache.name} from the workspace as project instructions.`, 'info', 6000);
    return contextCache;
  }
  function promptSection() {
    if (!H.fs.hasRoot()) return '';
    let s = `\n\n# Working in a code project
- Start with project_overview when you do not already know this project; then narrow down with fs_search, code_symbol and code_outline. Read whole files only when you actually need the whole file.
- code_outline shows a file's structure without its body; code_symbol finds where something is defined and who uses it; code_deps shows what a file imports and what imports it.
- Refer to code as \`path/to/file.js:123\` so the user can open it.
- Git tools (git_status, git_diff, git_log, git_show, git_blame) read the repository directly and are read-only: they can show history and uncommitted changes but cannot commit, push or check out. If the folder is not a repository, workspace_changes reports what changed since the last snapshot instead.
- Before editing, read the exact region you are changing; after editing, re-read it to confirm. Match the surrounding style and reuse what the project already has instead of adding new patterns.
- Delegate wide sweeps over many files to run_subagent so the main conversation keeps its context.
- The previous contents of every file you change are kept, and the user can revert them from "Files changed in this chat"; that is not a reason to be careless, but a mistaken edit is recoverable.`;
    if (contextCache) s += `\n\n# Project instructions (${contextCache.name})\nThe user keeps this file in the project root; treat it as their standing instructions for this codebase. A direct request from the user overrides it.\n<project_context source="${contextCache.name}">\n${contextCache.content}\n</project_context>`;
    return s;
  }

  /* Each folder keeps its own caches, so switching between chats does not throw them away — only the things that
     describe the current folder (project instructions, the branch on the button) have to be refreshed. */
  H.bus?.on?.('workspace', () => {
    inst.delete('none');                          // the placeholder for "no folder open" is never worth keeping
    H.git?.quickBranch?.().catch(() => { });     // one small file read: the branch for the folder pill and the prompt
    refreshContext().catch(() => { });
  });

  /* folder-independent helpers live on the target; everything else forwards to the current folder's instance */
  const shared = {
    promptSection, refreshContext, outlineText,
    langOf, matchesIgnore, ignoredWith, searchable, DEFAULT_SKIP, BINARY_EXT, RULES,
  };
  return new Proxy(shared, { get: (t, k) => (k in t ? t[k] : of()[k]) });
})();
