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
    description: 'List files and directories in the workspace. Returns paths relative to workspace root. A recursive listing follows the project\'s .gitignore and skips .git and node_modules. For a first look at an unfamiliar project use project_overview instead.',
    parameters: obj({ path: str('Directory path relative to workspace root (empty = root)'), recursive: bool('List recursively (respects .gitignore)') }),
    run: async ({ path = '', recursive = false }) => {
      if (!recursive) return ok({ workspace: H.fs.name(), entries: await H.fs.list(path, { recursive: false }) });
      const base = H.fs.resolve(path).path;
      const { files, dirs, truncated } = await H.code.index();
      const inScope = (p) => !base || p === base || p.startsWith(base + '/');
      const entries = files.filter(f => inScope(f.path)).map(f => ({ path: f.path, kind: 'file', size: f.size }));
      return ok({
        workspace: H.fs.name(), count: entries.length, directories: dirs.filter(d => d.path && inScope(d.path)).map(d => d.path).slice(0, 500),
        entries: entries.slice(0, 2000), truncated: truncated || entries.length > 2000,
      });
    },
  });
  async function readOneFile(path, startLine, endLine, ctx, budget = 60000) {
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
    return { path, totalLines: lines.length, from: s, to: e, content: H.clamp(slice, budget) };
  }
  def({
    name: 'fs_read', group: 'Files', risk: 'safe',
    description: 'Read a file from the workspace as text, with line numbers. PDF, Word (.docx), PowerPoint (.pptx) and spreadsheets (.xlsx/.xls/.ods/.csv) are converted to text automatically. Optionally a line range; pass `paths` to read several files in one call ("src/a.js" or "src/a.js:120-260").',
    parameters: obj({
      path: str('File path'), startLine: num('1-based first line (optional)'), endLine: num('1-based last line inclusive (optional)'),
      paths: { type: 'array', items: { type: 'string' }, description: 'Several files at once, each "path" or "path:startLine-endLine". Use instead of path.' },
    }),
    run: async ({ path, startLine, endLine, paths }, ctx) => {
      if (Array.isArray(paths) && paths.length) {
        const budget = Math.max(4000, Math.floor(60000 / paths.length));
        const files = [];
        for (const spec of paths.slice(0, 25)) {
          const m = String(spec).match(/^(.*?):(\d+)-(\d+)$/);
          const p = m ? m[1] : String(spec);
          try { files.push(await readOneFile(p, m ? Number(m[2]) : undefined, m ? Number(m[3]) : undefined, ctx, budget)); }
          catch (e) { files.push({ path: p, error: H.explainError(e, { path: p }) }); }
        }
        return ok({ files, note: paths.length > 25 ? 'Only the first 25 paths were read.' : undefined });
      }
      if (!path) throw new Error('fs_read needs either "path" or "paths".');
      return ok(await readOneFile(path, startLine, endLine, ctx));
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
    description: 'Search file contents (grep) across the workspace. Results are grouped by file with line numbers and optional context lines. Files ignored by .gitignore, binaries, minified bundles and lockfiles are skipped.',
    parameters: obj({
      query: str('Text or regex to search for'), path: str('Directory to search in (default root)'),
      regex: bool('Treat query as a regular expression'), caseSensitive: bool('Case sensitive'),
      glob: str('Only files matching glob, e.g. *.js or src/**/*.py'), exclude: str('Skip files matching this glob'),
      contextLines: num('Lines of context before and after each match (default 0)'),
      maxResults: num('Max files with matches (default 100)'), maxPerFile: num('Max matches per file (default 20)'),
      filesOnly: bool('Return only the file names, not the matching lines'),
      includeNoisy: bool('Also search lockfiles and generated files'),
      refresh: bool('Re-scan the workspace instead of using the cached file index'),
    }, ['query']),
    run: async (a) => ok(await H.code.search(a)),
  });
  def({
    name: 'fs_find', group: 'Files', risk: 'safe',
    description: 'Find files by glob pattern, e.g. "**/*.ts" or "*.md". Respects .gitignore.',
    parameters: obj({ glob: str('Glob pattern'), path: str('Directory to search in'), refresh: bool('Re-scan the workspace first') }, ['glob']),
    run: async ({ glob, path = '', refresh }) => {
      const files = await H.code.find(glob, path, { refresh });
      return ok({ count: files.length, files: files.slice(0, 1000), truncated: files.length > 1000 });
    },
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

  /* ===================== CODE INTELLIGENCE ===================== */
  def({
    name: 'project_overview', group: 'Code', risk: 'safe',
    description: 'Understand the open project in one call: languages and sizes, directory structure, manifests (package.json, pyproject.toml, go.mod, Cargo.toml…) with their scripts and dependencies, entry points, test and CI locations, README head, and git branch/remote if it is a repository. Call this first when you do not already know the project.',
    parameters: obj({ refresh: bool('Re-scan the workspace instead of using the cached index') }),
    run: async ({ refresh }) => ok(await H.code.overview({ refresh })),
  });
  def({
    name: 'code_outline', group: 'Code', risk: 'safe',
    description: 'Structure of a source file without its contents: classes, functions, methods, types and imports with line numbers. Use it to decide which part of a large file to read. Pass a glob instead of a path to outline many files at once.',
    parameters: obj({ path: str('File path'), glob: str('Outline every file matching this glob instead, e.g. "src/**/*.ts"'), maxSymbols: num('Max symbols per file (default 400)') }),
    run: async ({ path, glob, maxSymbols }) => {
      if (glob) return ok(await H.code.outlineGlob(glob, path || '', {}));
      if (!path) throw new Error('code_outline needs either "path" or "glob".');
      return ok(await H.code.outline(path, { maxSymbols }));
    },
  });
  def({
    name: 'code_symbol', group: 'Code', risk: 'safe',
    description: 'Find where a symbol (function, class, constant, method) is defined and where it is used. Returns definitions with surrounding context first, then references grouped by file. Better than fs_search when you know the name of the thing you are looking for.',
    parameters: obj({ name: str('Symbol name, e.g. "executeToolCall" or "UserService"'), path: str('Limit to a directory'), refresh: bool('Re-scan the workspace first') }, ['name']),
    run: async ({ name, path, refresh }) => ok(await H.code.symbol(name, { path, refresh })),
  });
  def({
    name: 'code_deps', group: 'Code', risk: 'safe',
    description: 'Import graph around a file: what it imports (resolved to workspace paths where possible) and which files import it. Use it to see what a change would affect.',
    parameters: obj({ path: str('File path'), reverse: bool('Also find files that import this one (default true)') }, ['path']),
    run: async ({ path, reverse = true }) => ok(await H.code.deps(path, { reverse })),
  });
  def({
    name: 'workspace_snapshot', group: 'Code', risk: 'safe',
    description: 'Record the current state of the workspace as a baseline, so workspace_changes can later show everything that changed. Useful in folders that are not git repositories (for example extracted from a zip). Replaces any previous baseline for this folder.',
    parameters: obj({ note: str('What this baseline marks, e.g. "before refactor"') }),
    run: async ({ note }) => ok(await H.code.snapshot({ note })),
  });
  def({
    name: 'workspace_changes', group: 'Code', risk: 'safe',
    description: 'Show every file added, changed or deleted since the last workspace_snapshot, with unified diffs. The non-git equivalent of git_diff; use git_diff when the folder is a repository.',
    parameters: obj({ paths: { type: 'array', items: { type: 'string' }, description: 'Limit to these files or directories' }, statOnly: bool('Only list the files, without diffs'), context: num('Context lines (default 3)') }),
    run: async ({ paths, statOnly, context }) => ok(clampDiff(await H.code.changes({ paths, statOnly, context }))),
  });

  /* ===================== GIT (read-only) ===================== */
  /* Diffs can be huge: keep whole patches for the first files and fall back to stats for the rest. */
  function clampDiff(r, budget = 60000) {
    if (!r?.files?.length) return r;
    let used = 0, dropped = 0;
    r.files = r.files.map(f => {
      if (!f.patch) return f;
      used += f.patch.length;
      if (used <= budget) return f;
      dropped++;
      const { patch, ...rest } = f;
      return { ...rest, patchOmitted: `${patch.length} characters; call again with paths:["${f.path}"] to see this one` };
    });
    if (dropped) r.note = `${dropped} of ${r.files.length} patches were omitted to stay within a reasonable size. Ask for specific paths, or use statOnly to see the file list first.`;
    return r;
  }
  const gitGroup = 'Git';
  def({
    name: 'git_status', group: gitGroup, risk: 'safe',
    description: 'Current state of the git repository in the workspace: branch, upstream, HEAD commit, and which files are modified, deleted, untracked or staged. Read-only — the harness can never commit, push or check out.',
    parameters: obj({ thorough: bool('Hash every tracked file instead of trusting size and timestamp (slower, exact)') }),
    run: async ({ thorough }) => ok(await H.git.status({ thorough })),
  });
  def({
    name: 'git_diff', group: gitGroup, risk: 'safe',
    description: 'Unified diff. With no arguments: the uncommitted working-tree changes against HEAD (what "git diff HEAD" shows, including untracked files). With `from` (and optionally `to`): the difference between two commits, branches or tags.',
    parameters: obj({
      from: str('Commit, branch or tag to compare from (e.g. "HEAD~1", "main", a sha). Omit to diff the working tree.'),
      to: str('Commit to compare to (default HEAD). Only used together with from.'),
      paths: { type: 'array', items: { type: 'string' }, description: 'Limit to these files or directories' },
      context: num('Context lines (default 3)'), statOnly: bool('Only list changed files with their status'),
      thorough: bool('For the working-tree diff: hash every tracked file instead of trusting timestamps'),
      downloadAs: str('Also save the full patch to the user\'s Downloads under this file name, e.g. "changes.patch"'),
    }),
    run: async ({ from, to, paths, context, statOnly, thorough, downloadAs }) => {
      const r = from ? await H.git.diffRefs({ from, to: to || 'HEAD', paths, context, statOnly })
        : await H.git.diffWorktree({ paths, context, thorough });
      if (statOnly && !from) r.files = r.files.map(({ patch, ...f }) => f);
      const full = r.files.map(f => f.patch).filter(Boolean).join('');
      if (downloadAs) { H.download(String(downloadAs).replace(/[/\\]/g, '_'), full || '(no changes)', 'text/x-patch'); r.downloaded = downloadAs; }
      r.summary = { files: r.files.length, added: r.files.reduce((n, f) => n + (f.added || 0), 0), removed: r.files.reduce((n, f) => n + (f.removed || 0), 0) };
      return ok(clampDiff(r));
    },
  });
  def({
    name: 'git_log', group: gitGroup, risk: 'safe',
    description: 'Commit history: sha, author, date and subject, newest first. Filter by path, author, date or message text.',
    parameters: obj({
      ref: str('Branch, tag or commit to start from (default HEAD)'), max: num('How many commits (default 20)'), skip: num('Skip this many first'),
      path: str('Only commits that touched this file or directory'), author: str('Substring of the author name or email'),
      since: str('Only commits after this date (ISO, e.g. 2025-01-01)'), until: str('Only commits before this date'),
      messageContains: str('Only commits whose message contains this text'),
    }),
    run: async (a) => ok(await H.git.log(a)),
  });
  def({
    name: 'git_show', group: gitGroup, risk: 'safe',
    description: 'Everything about one commit: message, author, parents and the files it changed, with their diffs.',
    parameters: obj({ ref: str('Commit sha, branch or tag (default HEAD)'), patch: bool('Include the diffs (default true)'), context: num('Context lines (default 3)'), paths: { type: 'array', items: { type: 'string' }, description: 'Limit to these files' } }),
    run: async ({ ref = 'HEAD', patch = true, context, paths }) => {
      const sha = await H.git.resolve(ref);
      const c = await H.git.commit(sha);
      const files = await H.git.commitChanges(sha, { patch, context, paths });
      return ok(clampDiff({ sha, short: sha.slice(0, 8), subject: c.subject, message: c.message, author: c.author, committer: c.committer, date: c.date, parents: c.parents, fileCount: files.length, files }));
    },
  });
  def({
    name: 'git_show_file', group: gitGroup, risk: 'safe',
    description: 'The contents of a file as it was at a given commit, branch or tag — what the file looked like before a change.',
    parameters: obj({ path: str('File path'), ref: str('Commit, branch or tag (default HEAD)'), startLine: num('1-based first line'), endLine: num('1-based last line') }, ['path']),
    run: async ({ path: raw, ref = 'HEAD', startLine, endLine }) => {
      const { path } = H.fs.resolve(raw);        // normalise the path against the folder's root
      const sha = await H.git.resolve(ref);
      const map = await H.git.treeMap((await H.git.commit(sha)).tree);
      const e = map.get(path);
      if (!e) throw new Error(`"${path}" does not exist at ${ref} (${sha.slice(0, 8)}). Use git_show to see which paths that commit contains.`);
      const text = await H.git.blobText(e.sha);
      const lines = text.split('\n');
      const s = Math.max(1, startLine || 1), en = Math.min(lines.length, endLine || lines.length);
      return ok({ path, ref, sha: sha.slice(0, 8), blob: e.sha.slice(0, 8), totalLines: lines.length, from: s, to: en, content: H.clamp(lines.slice(s - 1, en).map((l, i) => `${String(s + i).padStart(5)}| ${l}`).join('\n'), 60000) });
    },
  });
  def({
    name: 'git_file_history', group: gitGroup, risk: 'safe',
    description: 'The commits that touched one file, newest first, optionally with the change each one made to it.',
    parameters: obj({ path: str('File path'), max: num('How many commits (default 10)'), patch: bool('Include each commit\'s diff of this file'), ref: str('Start from this ref (default HEAD)') }, ['path']),
    run: async ({ path: raw, max = 10, patch = false, ref = 'HEAD' }) => {
      const { path } = H.fs.resolve(raw);
      const h = await H.git.log({ ref, path, max });
      if (!patch) return ok(h);
      const commits = [];
      for (const c of h.commits) commits.push({ ...c, files: undefined, changes: await H.git.commitChanges(c.sha, { paths: [path], patch: true }) });
      return ok(clampDiff({ ...h, commits, files: commits.flatMap(c => c.changes) }));
    },
  });
  def({
    name: 'git_branches', group: gitGroup, risk: 'safe',
    description: 'Local branches, remote-tracking branches and tags, each with its tip commit, newest first.',
    parameters: obj({}),
    run: async () => ok(await H.git.branches()),
  });
  def({
    name: 'git_blame', group: gitGroup, risk: 'safe',
    description: 'Who last changed each line of a file, and in which commit. Approximate: it reconstructs attribution from the file\'s history and does not follow renames.',
    parameters: obj({ path: str('File path'), ref: str('Start from this ref (default HEAD)'), maxRevisions: num('How far back to walk (default 40)'), startLine: num('First line to return'), endLine: num('Last line to return') }, ['path']),
    run: async ({ path: raw, ref, maxRevisions, startLine, endLine }) => {
      const { path } = H.fs.resolve(raw);
      const r = await H.git.blame(path, { ref, maxRevisions });
      if (startLine || endLine) r.lines = r.lines.slice(Math.max(0, (startLine || 1) - 1), endLine || undefined);
      if (r.lines.length > 600) { r.note = `Showing the first 600 of ${r.lines.length} lines; pass startLine/endLine for the rest.`; r.lines = r.lines.slice(0, 600); }
      return ok(r);
    },
  });

  /* ===================== CODE EXECUTION ===================== */
  def({
    name: 'run_javascript', group: 'Code', risk: 'write',
    description: 'Run JavaScript in a sandboxed Web Worker (no DOM, no workspace access, network via fetch allowed). Use console.log for output; the value of a final `return` is captured. Async/await supported.',
    parameters: obj({ code: str('JavaScript code (body of an async function; use return to yield a value)'), input: { description: 'Optional JSON input available as `input`' }, timeoutMs: num('Timeout in ms (default 15000)') }, ['code']),
    run: async ({ code, input, timeoutMs }, ctx) => ok(await H.runtime.runJS(code, { timeout: timeoutMs || 15000, input, signal: ctx?.signal })),
  });
  def({
    name: 'run_python', group: 'Code', risk: 'write',
    description: 'Run Python code in the browser via Pyodide (numpy, pandas, etc. available; pure-python packages installable). Output = stdout + value of last expression. No workspace access; pass files via `files`.',
    parameters: obj({ code: str('Python code'), packages: { type: 'array', items: { type: 'string' }, description: 'Packages to load/install, e.g. ["numpy","requests"]' }, files: { type: 'object', description: 'Map filename -> text content to place in the Python working dir', additionalProperties: { type: 'string' } }, timeoutMs: num('Timeout ms (default 60000)') }, ['code']),
    run: async ({ code, packages, files, timeoutMs }, ctx) => ok(await H.runtime.runPython(code, { packages: packages || [], files: files || {}, timeout: timeoutMs || 60000, onStatus: ctx.onStatus, signal: ctx.signal })),
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
    run: async ({ expression }, ctx) => { const r = await H.runtime.runJS('return (' + expression + ');', { timeout: 3000, network: false, signal: ctx?.signal }); if (r.error) throw new Error(r.error); return ok({ result: r.result }); },
  });

  /* ===================== WEB ===================== */
  const originOf = (a) => { try { return new URL(String(a?.url || '')).origin; } catch { return null; } };
  def({
    name: 'web_fetch', group: 'Web', risk: 'safe', scope: originOf,
    description: 'Fetch a URL directly from the browser and return readable text (HTML converted to markdown-ish text) or raw body. Sites that do not allow cross-origin requests cannot be fetched unless the user configured a proxy; in that case suggest open_url so the user can read the page themselves.',
    parameters: obj({ url: str('Absolute URL'), raw: bool('Return raw body instead of extracted text'), maxChars: num('Max characters to return (default 20000)') }, ['url']),
    run: async ({ url, raw = false, maxChars = 20000 }, ctx) => {
      let text, via = 'direct', status; const signal = ctx?.signal;
      if (!/^https?:\/\//i.test(url)) throw new Error(`url must be an absolute http(s) URL, got "${url}".`);
      try {
        if (H.bridge.has(url)) {   // a logged-in tab of that site is connected: use it (handles sites without CORS and behind login)
          const b = await H.bridge.fetch(url, { headers: { 'Accept': 'text/html,application/json,text/plain,*/*' }, signal });
          status = b.status; via = 'browser session bridge'; const ct = b.headers?.['content-type'] || '';
          text = raw || !/html/i.test(ct) ? (b.body || '') : H.htmlToText(b.body || '', url);
          return ok({ url, status, via, content: H.clamp(text, maxChars) });
        }
        const r = await fetchWithProxy(url, { headers: { 'Accept': 'text/html,application/json,text/plain,*/*' }, signal });
        status = r.status;
        const ct = r.headers.get('content-type') || '';
        const body = await r.text();
        text = raw || !/html/i.test(ct) ? body : H.htmlToText(body, url);
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        if (!H.settings.get('jinaFallback')) throw new Error(`Could not fetch ${url} directly from the browser (the site probably does not allow cross-origin requests). No third-party fetch service is enabled (Settings > Security). Suggest open_url so the user can read the page, or ask them to paste the content.`);
        const r = await fetch('https://r.jina.ai/' + url, { headers: { 'Accept': 'text/plain' }, signal });
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
    run: async ({ query, maxChars = 12000 }, ctx) => {
      const tpl = H.settings.get('searchTemplate');
      if (!tpl) throw new Error('web_search is disabled: no search provider is configured (Settings > Security & web). Ask the user to configure one, or use open_url to open a search page for them.');
      const url = tpl.replace('{q}', encodeURIComponent(query));
      const headers = { 'Accept': 'application/json, text/plain' };
      const hk = H.settings.get('searchKeyHeader'), hv = H.settings.get('searchKeyValue');
      if (hk && hv) headers[hk] = hv;
      const r = await fetchWithProxy(url, { headers, signal: ctx?.signal }, { allowProxy: !(hk && hv) });   // a keyed search API is never sent via the proxy
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
    run: async ({ url, method = 'GET', headers = {}, body, timeoutMs = 30000 }, ctx) => {
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
      ctx?.signal?.addEventListener('abort', () => ctl.abort(), { once: true });   // Stop cancels the request too
      const init = { method, headers: { ...headers }, signal: ctl.signal };
      if (body !== undefined && method !== 'GET' && method !== 'HEAD') {
        if (typeof body === 'object') { init.body = JSON.stringify(body); init.headers['Content-Type'] ||= 'application/json'; }
        else init.body = String(body);
      }
      if (!/^https?:\/\//i.test(url)) throw new Error(`url must be an absolute http(s) URL, got "${url}".`);
      try {
        if (H.bridge.has(url)) {
          const b = await H.bridge.fetch(url, { method, headers: init.headers, body: init.body, signal: ctl.signal });
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
    run: async ({ data, expression }, ctx) => { const d = typeof data === 'string' ? H.tryJSON(data, data) : data; const r = await H.runtime.runJS(`const data = input; return (${expression});`, { input: d, timeout: 5000, network: false, signal: ctx?.signal }); if (r.error) throw new Error(r.error); return ok({ result: r.result }); },
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
      if (!ctx?.toolMsg || ctx.subagent) return Promise.resolve({ answer: null, cancelled: true, note: 'ask_user is not available inside a sub-agent. Finish with your best assumption and state the open question in your final answer so the main assistant can ask the user.' });
      return H.agent.askUser(ctx.chatId, ctx.toolMsg, question, choices, ctx.signal, ctx.images);
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
    description: 'Load a skill (a reusable instruction set / workflow) by name and return its full instructions. Call this when a user request matches an available skill, and before rewriting an existing skill with skill_write.',
    parameters: obj({ name: str('Skill name') }, ['name']),
    run: async ({ name }) => { const s = H.skills.get(name); if (!s) throw new Error('Unknown skill: ' + name + '. Available: ' + H.skills.list().map(x => x.name).join(', ')); return ok({ name: s.name, description: s.description, instructions: s.content }); },
  });
  def({
    name: 'list_skills', group: 'Skills', risk: 'safe',
    description: 'List available skills with descriptions.',
    parameters: obj({}),
    run: async () => ok({ skills: H.skills.list().map(s => ({ name: s.name, description: s.description })) }),
  });
  /* Writing a skill is a small edit to a file the user owns, so it is shaped like one: the permission prompt shows
     the whole body before it lands, and the result carries a unified diff the tool card renders. */
  const skillPath = (name) => `skills/${name}.md`;
  def({
    name: 'skill_write', group: 'Skills', risk: 'write',
    description: 'Create a skill, or replace an existing one with the same name. A skill is a reusable instruction set the user invokes by typing /name in the chat box, or that you load later with use_skill. Write the instructions in the second person, as concrete steps. Read an existing skill with use_skill first: this replaces it whole.',
    parameters: obj({
      name: str('Short kebab-case name; this is what the user types as /name'),
      description: str('One line saying what the skill is for; you see this when deciding whether to load it'),
      content: str('The instructions, in markdown, without frontmatter'),
    }, ['name', 'description', 'content']),
    run: async ({ name, description, content }) => {
      const v = H.skills.validate(name);
      if (!v.ok) throw new Error(v.error);
      const old = H.skills.get(v.name);
      const next = { name: v.name, description: String(description || '').trim(), content: String(content || '').trim() };
      const path = skillPath(v.name);
      const patch = H.diff.unified(old ? H.skills.serialize(old) : null, H.skills.serialize(next), { path, context: 3 });
      H.skills.upsert(next, { by: 'model' });
      return ok({ name: v.name, [old ? 'updated' : 'created']: true, path, patch, invoke: '/' + v.name, note: 'The user can revert this in Settings > Skills.' });
    },
  });
  def({
    name: 'skill_delete', group: 'Skills', risk: 'danger',
    description: 'Delete a skill by name. The user can revert this from Settings > Skills.',
    parameters: obj({ name: str('Skill name') }, ['name']),
    run: async ({ name }) => {
      const s = H.skills.get(name);
      if (!s) throw new Error('Unknown skill: ' + name + '. Available: ' + (H.skills.list().map(x => x.name).join(', ') || 'none'));
      const path = skillPath(s.name);
      const patch = H.diff.unified(H.skills.serialize(s), null, { path, context: 3 });
      H.skills.remove(s.name, { by: 'model' });
      return ok({ deleted: s.name, path, patch, note: 'The user can revert this in Settings > Skills.' });
    },
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
