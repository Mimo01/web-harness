/* Update check: compares H.ABOUT.version with version.json in the GitHub repository (raw.githubusercontent.com allows CORS).
   Runs on startup and every hour; can be disabled in Settings > Web access. Nothing but a GET of a public file is sent. */
H.update = (() => {
  const KEY = 'harness.update.lastCheck';
  const cmp = (a, b) => { const pa = String(a).split('.').map(n => parseInt(n, 10) || 0), pb = String(b).split('.').map(n => parseInt(n, 10) || 0); for (let i = 0; i < Math.max(pa.length, pb.length); i++) { if ((pa[i] || 0) > (pb[i] || 0)) return 1; if ((pa[i] || 0) < (pb[i] || 0)) return -1; } return 0; };
  let latest = null;

  async function check({ manual = false } = {}) {
    if (!manual && !H.settings.get('checkUpdates')) return null;
    const url = H.ABOUT.versionUrl + (manual ? '?t=' + Date.now() : '');
    try {
      const r = await fetch(url, { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      latest = await r.json();
      localStorage.setItem(KEY, String(Date.now()));
      const newer = cmp(latest.version, H.ABOUT.version) > 0;
      H.bus.emit('update', { latest, newer });
      if (newer && (manual || localStorage.getItem('harness.update.dismissed') !== latest.version)) notify(latest);
      else if (manual) H.toast(`You have the latest version (${H.ABOUT.version}).`, 'success');
      return { latest, newer };
    } catch (e) { if (manual) H.toast('Update check failed: ' + e.message, 'error'); return null; }
  }
  function notify(v) {
    const box = H.$('#toasts');
    if (box.querySelector('.update-toast')) return;
    const t = H.el('div', { class: 'toast update-toast' }, [
      H.el('div', {}, [H.el('b', {}, [`Version ${v.version} is available`]), H.el('div', { class: 'small muted' }, [`You are running ${H.ABOUT.version}.` + (v.notes ? ' ' + v.notes : '')])]),
      H.el('div', { class: 'row gap', style: 'margin-top:8px' }, [
        H.el('a', { class: 'btn sm primary', href: v.url || H.ABOUT.repoUrl, target: '_blank', rel: 'noopener' }, ['Download']),
        H.el('button', { class: 'btn sm ghost', onclick: () => { localStorage.setItem('harness.update.dismissed', v.version); t.remove(); } }, ['Later']),
      ]),
    ]);
    box.append(t);
  }
  function start() {
    const last = +localStorage.getItem(KEY) || 0;
    if (Date.now() - last > 3600 * 1000) setTimeout(() => check(), 4000);
    setInterval(() => check(), 3600 * 1000);
  }
  return { check, start, latest: () => latest, cmp };
})();
