const norm = (v) => { try { return v.trim() === 'file://' ? 'file://' : new URL(v.includes('://') ? v : 'https://' + v).origin; } catch { return null; } };
async function renderList(key, ul) {
  const data = await chrome.storage.sync.get({ [key]: [] }); const arr = data[key];
  ul.innerHTML = '';
  for (const o of arr) { const li = document.createElement('li'); const s = document.createElement('span'); s.textContent = o; const b = document.createElement('button'); b.textContent = 'Remove'; b.onclick = async () => { await chrome.storage.sync.set({ [key]: arr.filter(x => x !== o) }); renderList(key, ul); }; li.append(s, b); ul.append(li); }
  if (!arr.length) ul.innerHTML = '<li class="hint">Nothing added yet.</li>';
}
async function add(key, input, ul) {
  const v = norm(input.value); if (!v) { alert('Enter a valid URL'); return; }
  const data = await chrome.storage.sync.get({ [key]: [] }); const arr = data[key]; if (!arr.includes(v)) arr.push(v);
  await chrome.storage.sync.set({ [key]: arr }); input.value = ''; renderList(key, ul);
}
const H = document.getElementById('harness'), HL = document.getElementById('harnessList'), O = document.getElementById('origin'), OL = document.getElementById('list');
document.getElementById('addHarness').onclick = () => add('harness', H, HL);
document.getElementById('add').onclick = () => add('allowed', O, OL);
const params = new URLSearchParams(location.search); if (params.get('add')) O.value = params.get('add'); if (params.get('harness')) H.value = params.get('harness');
renderList('harness', HL); renderList('allowed', OL);
