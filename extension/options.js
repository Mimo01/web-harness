/* Two lists. "Harness page" is just a stored allow-list (the content script already runs everywhere and stays
   inert unless the page is on it). "APIs it may call" is backed by a real Chrome host permission, requested from
   the click that adds it and revoked when it is removed — so the extension holds access to exactly the sites
   listed here and nothing else. A row whose permission is missing (added before this version, or revoked in
   chrome://extensions) offers a Grant button. */
const norm = (v) => { try { return v.trim() === 'file://' ? 'file://' : new URL(v.includes('://') ? v : 'https://' + v).origin; } catch { return null; } };
const pattern = (o) => o + '/*';
const has = (o) => chrome.permissions.contains({ origins: [pattern(o)] }).catch(() => false);

async function renderList(key, ul) {
  const data = await chrome.storage.sync.get({ [key]: [] }); const arr = data[key];
  ul.innerHTML = '';
  for (const o of arr) {
    const li = document.createElement('li');
    const s = document.createElement('span'); s.textContent = o;
    li.append(s);
    if (key === 'allowed') {
      const state = document.createElement('span'); state.className = 'hint'; state.textContent = 'checking…';
      li.append(state);
      has(o).then(ok => {
        state.textContent = ok ? 'access granted' : 'access not granted';
        if (ok) return;
        const g = document.createElement('button'); g.textContent = 'Grant'; g.className = 'primary';
        g.onclick = async () => { if (await chrome.permissions.request({ origins: [pattern(o)] })) renderList(key, ul); };
        li.insertBefore(g, li.lastChild);
      });
    }
    const b = document.createElement('button'); b.textContent = 'Remove';
    b.onclick = async () => {
      await chrome.storage.sync.set({ [key]: arr.filter(x => x !== o) });
      if (key === 'allowed') await chrome.permissions.remove({ origins: [pattern(o)] }).catch(() => { });
      renderList(key, ul);
    };
    li.append(b); ul.append(li);
  }
  if (!arr.length) ul.innerHTML = '<li class="hint">Nothing added yet.</li>';
}
async function add(key, input, ul) {
  const v = norm(input.value); if (!v) { alert('Enter a valid URL'); return; }
  /* the request has to happen on this click: Chrome only shows the permission dialog from a user gesture */
  if (key === 'allowed' && !await has(v) && !await chrome.permissions.request({ origins: [pattern(v)] })) {
    alert('Without access to ' + v + ' the extension cannot call it. Add it again and accept the permission prompt.');
    return;
  }
  const data = await chrome.storage.sync.get({ [key]: [] }); const arr = data[key]; if (!arr.includes(v)) arr.push(v);
  await chrome.storage.sync.set({ [key]: arr }); input.value = ''; renderList(key, ul);
}
const H = document.getElementById('harness'), HL = document.getElementById('harnessList'), O = document.getElementById('origin'), OL = document.getElementById('list');
document.getElementById('addHarness').onclick = () => add('harness', H, HL);
document.getElementById('add').onclick = () => add('allowed', O, OL);
const params = new URLSearchParams(location.search); if (params.get('add')) O.value = params.get('add'); if (params.get('harness')) H.value = params.get('harness');
renderList('harness', HL); renderList('allowed', OL);
