/* Bootstrap */
(async function () {
  try { window.name = 'llm-harness'; } catch { }
  H.ui.init();
  if (H.bridge.embedded()) { document.body.classList.add('embedded'); H.$('#sidebar').classList.add('collapsed'); }
  await H.fs.restore();
  H.ui.updateWorkspaceBtn(H.fs.hasRoot() ? H.fs.name() : '');
  const recent = (await H.db.listChats())[0];
  if (recent && !recent.messages.length) await H.agent.load(recent.id); else await H.agent.reset();   // reuse an empty chat instead of creating one per reload
  H.ui.renderChatList();
  if (H.settings.apiKey()) { H.ui.refreshModels().catch(() => { }); H.usage.refreshModelInfo(); } else { H.ui.setStatus('', 'not configured'); H.ui.openSettings('connection'); }
  H.plugins.connectEnabledMcp();
  H.update.start();
  if (!H.fs.supported()) H.toast('This browser lacks the File System Access API; file tools use an in-memory workspace. Use Chrome/Edge for real folders.', 'warn', 8000);
  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); H.agent.reset(); H.$('#input').focus(); }
    if ((e.metaKey || e.ctrlKey) && e.key === '/') { e.preventDefault(); H.ui.openSettings('connection'); }
  });
})();
