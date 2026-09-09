/* Settings (localStorage) + secrets store (localStorage or sessionStorage depending on "remember secrets") */
H.secrets = (() => {
  const PREFIX = 'harness.secret.';
  const FLAG = 'harness.persistSecrets';
  const persist = () => localStorage.getItem(FLAG) !== 'false';   // default: remember on this device
  const store = () => persist() ? localStorage : sessionStorage;
  return {
    get: (k) => localStorage.getItem(PREFIX + k) ?? sessionStorage.getItem(PREFIX + k) ?? '',
    set: (k, v) => { localStorage.removeItem(PREFIX + k); sessionStorage.removeItem(PREFIX + k); if (v) store().setItem(PREFIX + k, v); },
    del: (k) => { localStorage.removeItem(PREFIX + k); sessionStorage.removeItem(PREFIX + k); },
    keys: () => [...Object.keys(localStorage), ...Object.keys(sessionStorage)].filter(k => k.startsWith(PREFIX)).map(k => k.slice(PREFIX.length)),
    persist,
    setPersist: (on) => {
      const keys = H.secrets.keys(); const vals = Object.fromEntries(keys.map(k => [k, H.secrets.get(k)]));
      localStorage.setItem(FLAG, on ? 'true' : 'false');
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
    searchKeyHeader: '',
    searchKeyValue: '',
    pyodideUrl: 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.js',
    allowPyodideCdn: true,
    disabledTools: [],
    theme: 'system',
    streaming: true,
    sendKey: 'enter',
    autoTitle: true,
    showCost: true,
    checkUpdates: true,
    transcriptionModel: '',        // e.g. whisper-1 on the LiteLLM proxy; empty = audio/video transcription off            // GET version.json from GitHub on startup / every 6 h
    settingsVersion: 2,
  };
  const stored = H.tryJSON(localStorage.getItem(KEY), {});
  let cur = Object.assign({}, defaults, stored);
  // migrate: API key used to live in settings
  if (cur.apiKey) { H.secrets.set('apiKey', cur.apiKey); delete cur.apiKey; localStorage.setItem(KEY, JSON.stringify(cur)); }
  if (!localStorage.getItem('harness.migrated.v3')) { if (cur.maxTokens === 4096) cur.maxTokens = 16000; localStorage.setItem(KEY, JSON.stringify(cur)); localStorage.setItem('harness.migrated.v3', '1'); }
  if (!localStorage.getItem('harness.migrated.v2')) {
    // v2: third-party web services are opt-in
    if (/jina\.ai/.test(cur.searchTemplate || '')) cur.searchTemplate = '';
    cur.jinaFallback = false; cur.settingsVersion = 2; localStorage.setItem(KEY, JSON.stringify(cur)); localStorage.setItem('harness.migrated.v2', '1');
  }
  if (cur.permissionMode) { cur.chatMode = cur.permissionMode === 'auto' ? 'auto' : 'default'; cur.alwaysAsk = cur.permissionMode === 'strict'; delete cur.permissionMode; }
  return {
    get: (k) => k ? cur[k] : cur,
    set: (patch) => { Object.assign(cur, patch); localStorage.setItem(KEY, JSON.stringify(cur)); H.bus.emit('settings', cur); },
    reset: () => { cur = Object.assign({}, defaults); localStorage.setItem(KEY, JSON.stringify(cur)); H.bus.emit('settings', cur); },
    apiKey: () => H.secrets.get('apiKey'),
    setApiKey: (v) => { H.secrets.set('apiKey', v); H.bus.emit('settings', cur); },
    defaults,
  };
})();
