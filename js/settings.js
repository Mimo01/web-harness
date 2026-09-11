/* Settings (localStorage) + secrets store (localStorage or sessionStorage depending on "remember secrets") */
H.secrets = (() => {
  const PREFIX = 'harness.secret.';
  const FLAG = 'harness.persistSecrets';
  const persist = () => localStorage.getItem(FLAG) !== 'false';   // default: remember on this device
  return {
    get: (k) => localStorage.getItem(PREFIX + k) ?? sessionStorage.getItem(PREFIX + k) ?? '',
    set: (k, v) => {
      localStorage.removeItem(PREFIX + k); sessionStorage.removeItem(PREFIX + k);
      if (!v) return;
      if (persist()) H.store.write(PREFIX + k, v);
      else try { sessionStorage.setItem(PREFIX + k, v); } catch (e) { console.warn('secret write failed', e); H.toast('Could not keep that secret for this session: ' + (e?.message || e), 'error', 8000); }
    },
    del: (k) => { localStorage.removeItem(PREFIX + k); sessionStorage.removeItem(PREFIX + k); },
    keys: () => [...Object.keys(localStorage), ...Object.keys(sessionStorage)].filter(k => k.startsWith(PREFIX)).map(k => k.slice(PREFIX.length)),
    persist,
    setPersist: (on) => {
      const keys = H.secrets.keys(); const vals = Object.fromEntries(keys.map(k => [k, H.secrets.get(k)]));
      H.store.write(FLAG, on ? 'true' : 'false');
      for (const [k, v] of Object.entries(vals)) H.secrets.set(k, v);
    },
    wipe: () => { for (const k of H.secrets.keys()) H.secrets.del(k); },
  };
})();

/* About: edit these two lines to change the credit / beer link shown in Settings → About */
H.ABOUT = {
  author: 'Milan Mozolak', version: window.APP_VERSION || '0.0.0',
  repoUrl: 'https://github.com/Mimo01/web-harness',
  versionUrl: 'https://raw.githubusercontent.com/Mimo01/web-harness/main/version.json',
};

H.settings = (() => {
  const KEY = 'harness.settings.v1';
  const defaults = {
    baseUrl: 'http://localhost:4000',
    model: '',
    models: [],                    // last fetched model list
    modelInfo: {},                 // model -> { maxInput, inCost, outCost } (per token, from LiteLLM /model/info)
    pricing: {},                   // manual overrides: model -> { in: $/1M, out: $/1M, context: tokens }
    defaultContext: 128000,
    temperature: 0.7,
    maxTokens: 16000,
    maxToolIterations: 25,
    systemPrompt: '',
    chatMode: 'default',           // default | auto | plan
    alwaysAsk: false,              // ask even for safe tools (strict)
    planExecuteMode: 'default',    // permission mode used when executing a plan
    corsProxy: '',                 // optional, user-provided proxy (third party unless self-hosted)
    jinaFallback: false,           // OFF by default: never send URLs to third parties
    searchTemplate: '',            // empty = web_search disabled until configured
    searchKeyHeader: '',           // the header name; its value is a secret (H.secrets 'searchKey'), never stored here
    pyodideUrl: 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.js',
    allowPyodideCdn: true,
    disabledTools: [],
    theme: 'system',
    streaming: true,
    sendKey: 'enter',
    autoTitle: true,
    showCost: true,
    checkUpdates: true,
    keepToolTurns: 2,              // tool results older than this many user turns are sent as short stubs
    toolStubChars: 240,
    autoCompact: true,             // summarise the older part of a chat when the context passes compactAt
    compactAt: 0.7,                // fraction of the model's context window
    compactKeepTurns: 3,           // most recent user turns are never summarised
    respectGitignore: true,        // file listings, search and the code index follow the project's .gitignore
    projectContextFile: true,      // load AGENTS.md / CLAUDE.md from the workspace root into the system prompt
    fileHistory: true,             // keep the previous contents of changed files so a chat's writes can be reverted
    maxIndexFiles: 20000,          // upper bound for the workspace file index
    transcriptionModel: '',        // e.g. whisper-1 on the LiteLLM proxy; empty = audio/video transcription off
    settingsVersion: 2,
  };
  const stored = H.tryJSON(localStorage.getItem(KEY), {});
  let cur = Object.assign({}, defaults, stored);
  // migrate: API key used to live in settings
  if (cur.apiKey) { H.secrets.set('apiKey', cur.apiKey); delete cur.apiKey; H.store.write(KEY, cur); }
  // migrate: the web-search API key is a credential, so it belongs in the secret store, not in the settings blob
  if (cur.searchKeyValue !== undefined) { if (cur.searchKeyValue) H.secrets.set('searchKey', cur.searchKeyValue); delete cur.searchKeyValue; H.store.write(KEY, cur); }
  if (!localStorage.getItem('harness.migrated.v3')) { if (cur.maxTokens === 4096) cur.maxTokens = 16000; H.store.write(KEY, cur); H.store.write('harness.migrated.v3', '1'); }
  if (!localStorage.getItem('harness.migrated.v2')) {
    // v2: third-party web services are opt-in
    if (/jina\.ai/.test(cur.searchTemplate || '')) cur.searchTemplate = '';
    cur.jinaFallback = false; cur.settingsVersion = 2; H.store.write(KEY, cur); H.store.write('harness.migrated.v2', '1');
  }
  if (cur.permissionMode) { cur.chatMode = cur.permissionMode === 'auto' ? 'auto' : 'default'; cur.alwaysAsk = cur.permissionMode === 'strict'; delete cur.permissionMode; }
  // another tab of the harness wrote settings: refresh the in-memory copy so this tab does not write stale values back
  window.addEventListener('storage', (e) => { if (e.key === KEY && e.newValue) { const v = H.tryJSON(e.newValue, null); if (v) { cur = Object.assign({}, defaults, v); H.bus.emit('settings', cur); } } });
  return {
    get: (k) => k ? cur[k] : cur,
    set: (patch) => { Object.assign(cur, patch); H.store.write(KEY, cur); H.bus.emit('settings', cur); },
    reset: () => { cur = Object.assign({}, defaults); H.store.write(KEY, cur); H.bus.emit('settings', cur); },
    apiKey: () => H.secrets.get('apiKey'),
    setApiKey: (v) => { H.secrets.set('apiKey', v); H.bus.emit('settings', cur); },
    /* the value for searchKeyHeader: a credential, so it lives with the other secrets and follows the same
       "remember on this device" switch and the same "forget all secrets" button */
    searchKey: () => H.secrets.get('searchKey'),
    setSearchKey: (v) => { H.secrets.set('searchKey', v); H.bus.emit('settings', cur); },
    defaults,
  };
})();
