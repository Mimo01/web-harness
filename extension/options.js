const listEl = document.getElementById('list'), input = document.getElementById('origin');
async function render() {
  const { allowed } = await chrome.storage.sync.get({ allowed: [] });
  listEl.innerHTML = '';
  for (const o of allowed) { const li = document.createElement('li'); const s = document.createElement('span'); s.textContent = o; const b = document.createElement('button'); b.textContent = 'Remove'; b.onclick = async () => { await chrome.storage.sync.set({ allowed: allowed.filter(x => x !== o) }); render(); }; li.append(s, b); listEl.append(li); }
  if (!allowed.length) listEl.innerHTML = '<li class="hint">No sites allowed yet.</li>';
}
document.getElementById('add').onclick = async () => {
  let v = input.value.trim(); if (!v) return;
  try { v = new URL(v.includes('://') ? v : 'https://' + v).origin; } catch { alert('Enter a valid URL'); return; }
  const { allowed } = await chrome.storage.sync.get({ allowed: [] });
  if (!allowed.includes(v)) allowed.push(v);
  await chrome.storage.sync.set({ allowed }); input.value = ''; render();
};
const params = new URLSearchParams(location.search); if (params.get('add')) { input.value = params.get('add'); }
render();
