/* Bootstrap */
(async function () {
  try { window.name = 'llm-harness'; } catch { }
  H.ui.init();
  await H.bridge.init();   // signing identity for the browser-session bridge (needed before the bookmarklet is shown)
  if (H.bridge.embedded()) { document.body.classList.add('embedded'); H.$('#sidebar').classList.add('collapsed'); }
  H.ui.updateWorkspaceBtn('');   // no folder until a chat is loaded: each one carries its own
  const recent = await H.db.recentChat();   // one index record via cursor: never reads message bodies at startup
  if (recent) await H.agent.load(recent.id); else await H.agent.reset();   // reopen the most recent chat; create one only when there is none
  H.ui.renderChatList();
  if (H.settings.apiKey()) H.ui.refreshModels().catch(() => { });   // which also loads /model/info for prices and context windows
  else { H.ui.setStatus('', 'not configured'); H.ui.openSettings('general'); }
  H.plugins.connectEnabledMcp();
  H.update.start();
  // one harness tab per browser profile: two tabs would overwrite each other's settings and usage totals
  try {
    const bc = new BroadcastChannel('llm-harness'); const me = H.uid(); let warned = false;
    const warn = () => { if (warned) return; warned = true; H.toast('The harness is open in another tab. Settings, permissions and usage totals are per browser profile, so two tabs overwrite each other; keep one tab open.', 'warn', 12000); };
    bc.onmessage = (e) => { const m = e.data || {}; if (m.from === me) return; if (m.type === 'hello') { bc.postMessage({ type: 'here', from: me }); warn(); } else if (m.type === 'here') warn(); };
    bc.postMessage({ type: 'hello', from: me });
  } catch { }
  if (!H.fs.supported()) H.toast('This browser lacks the File System Access API, so local folders cannot be opened and the file tools will not work. Use Chrome or Edge.', 'warn', 8000);
  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); H.agent.reset(); H.$('#input').focus(); }
    if ((e.metaKey || e.ctrlKey) && e.key === '/') { e.preventDefault(); H.ui.openSettings('general'); }
  });
})();
