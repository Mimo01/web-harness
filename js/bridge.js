/* Browser-session bridge: a bookmarklet run on a page of the target site (e.g. your Jira tab) turns that tab into a
   relay. The harness posts request descriptors to it via postMessage; the tab performs same-origin fetches with the
   user's existing login session and posts the results back. No token, no proxy, no admin, no third party. */
H.bridge = (() => {
  const bridges = new Map();   // origin -> { sources: Map<WindowProxy, {ts, mode}>, origin }
  const log = [];              // recent events for diagnostics
  const pending = new Map();   // id -> { resolve, reject, timer }
  const myOrigin = /^https?:\/\//.test(location.origin) ? location.origin : 'null';   // file:// pages have no usable origin

  window.addEventListener('message', (e) => {
    const m = e.data; if (!m || typeof m !== 'object') return;
    if (m.type === 'llm-bridge-hello' && /^https?:\/\//.test(e.origin)) {   // e.origin is set by the browser and cannot be spoofed
      let b = bridges.get(e.origin);
      const fresh = !b;
      if (!b) { b = { sources: new Map(), origin: e.origin }; bridges.set(e.origin, b); }
      const known = b.sources.has(e.source);
      b.sources.set(e.source, { ts: Date.now(), mode: m.mode || '' });
      try { e.source.postMessage({ type: 'llm-bridge-ack', harness: myOrigin, url: location.href.split('#')[0] }, e.origin); } catch { }
      if (!known) { note('hello from ' + e.origin + ' (' + (m.mode || '?') + ', tabs: ' + b.sources.size + ')'); H.bus.emit('bridge', list()); if (fresh) H.toast('Bridge connected: ' + e.origin, 'success'); }
      return;
    }
    if (m.type === 'llm-bridge-pong') { const p = pending.get(m.id); if (p && p.origin === e.origin) { clearTimeout(p.timer); pending.delete(m.id); p.resolve(m); } return; }
    if (m.type === 'llm-bridge-bye') {   // the tab is navigating away / closing: forget it right now
      const b = bridges.get(e.origin); if (b && b.sources.has(e.source)) { b.sources.delete(e.source); note('tab left ' + e.origin + ' (' + (m.reason || 'navigation') + ')'); if (!b.sources.size) bridges.delete(e.origin); H.bus.emit('bridge', list()); if (!b.sources.size) H.toast(`Bridge to ${e.origin} lost: the tab navigated or closed. Click the bookmark on it again.`, 'warn', 8000); }
      return;
    }
    if (m.type === 'llm-bridge-result') {
      const p = pending.get(m.id); if (!p) { note('result for unknown request ' + m.id + ' from ' + e.origin); return; }
      if (p.origin !== e.origin) { note('result from an unexpected origin ignored (' + e.origin + ')'); return; } // ids are random; the origin is browser-verified
      clearTimeout(p.timer); pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error)); else p.resolve(m);
    }
  });
  // liveness: a source stays registered until its window is closed, it says goodbye, or a probe/request fails.
  setInterval(() => {
    let changed = false;
    for (const [o, b] of bridges) { for (const [src] of b.sources) if (isClosed(src)) { b.sources.delete(src); changed = true; } if (!b.sources.size) { bridges.delete(o); changed = true; } }
    if (changed) H.bus.emit('bridge', list());
  }, 5000);
  /** ask one tab to answer immediately (message events are not throttled in background tabs) */
  function probe(source, origin, timeout = 3000) {
    const id = H.uid();
    return new Promise((resolve) => {
      const timer = setTimeout(() => { pending.delete(id); resolve(false); }, timeout);
      pending.set(id, { source, origin, resolve: () => resolve(true), reject: () => resolve(false), timer });
      try { source.postMessage({ type: 'llm-bridge-ping', id }, origin); } catch { clearTimeout(timer); pending.delete(id); resolve(false); }
    });
  }
  /** find a responsive tab for an origin, dropping dead ones; returns { source, info } or null */
  async function alive(origin) {
    const b = bridges.get(origin); if (!b) return null;
    const cands = [...b.sources.entries()].filter(([src]) => !isClosed(src)).sort((x, y) => y[1].ts - x[1].ts);
    for (const [src, info] of cands) {
      if (Date.now() - info.ts < 8000 || await probe(src, origin)) { info.ts = Date.now(); return { source: src, info }; }
      b.sources.delete(src); note('dropped unresponsive tab for ' + origin);
    }
    if (!b.sources.size) bridges.delete(origin);
    H.bus.emit('bridge', list());
    return null;
  }
  function isClosed(w) { try { return !!w.closed; } catch { return false; } }
  function note(t) { log.push(new Date().toLocaleTimeString() + ' ' + t); if (log.length > 40) log.shift(); }
  function best(b) { let s = null, bi = null; for (const [src, info] of b.sources) if (!isClosed(src) && (!bi || info.ts > bi.ts)) { s = src; bi = info; } return s ? { source: s, info: bi } : null; }

  function list() { return [...bridges.values()].map(b => { const x = best(b); return { origin: b.origin, tabs: b.sources.size, age: x ? Date.now() - x.info.ts : 0, mode: x ? x.info.mode : '' }; }); }
  /** UI helper: probe every bridge, returns list with `ok` flags */
  async function health() { const out = []; for (const b of [...bridges.values()]) { const x = await alive(b.origin); out.push({ origin: b.origin, ok: !!x, tabs: b.sources.size, mode: x?.info.mode || '' }); } return out; }
  /** open the target site from the harness so the new tab keeps window.opener (lets the bookmarklet link back without a popup) */
  function openSite(url) { try { const w = window.open(url, '_blank'); if (!w) H.toast('The browser blocked opening the tab. Open the site manually, the bookmarklet will fall back to panel mode.', 'warn', 7000); return w; } catch { return null; } }
  function has(url) { try { return bridges.has(new URL(url).origin); } catch { return false; } }

  /** fetch through the bridge of url's origin; resolves to { status, ok, headers, body } */
  async function fetch(url, init = {}) {
    const origin = new URL(url).origin;
    const had = bridges.has(origin);
    const x = await alive(origin);
    if (!x) throw new Error(had
      ? `The ${origin} tab that acted as the bridge is not responding: it was closed, reloaded, navigated to another page, or put to sleep by the browser. Ask the user to open ${origin} again (or switch to that tab) and click the "LLM Harness bridge" bookmark there; then retry.`
      : `No browser bridge connected for ${origin}. Ask the user to open a ${origin} tab where they are logged in and click the "LLM Harness bridge" bookmark (plugin setup, step 3).`);
    const b = bridges.get(origin);
    const id = H.uid();
    note('request ' + id + ' ' + (init.method || 'GET') + ' ' + url.replace(origin, ''));
    const started = Date.now();
    H.bus.emit('bridge-request', { id, origin, url, phase: 'sent' });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); note('timeout ' + id); b.sources.delete(x.source); H.bus.emit('bridge', list()); H.bus.emit('bridge-request', { id, origin, url, phase: 'timeout' }); reject(new Error(`Bridge request timed out after ${Math.round((init.timeout || 30000) / 1000)} s: the ${origin} tab did not answer. It may be on a login page, blocked by a dialog, or asleep. Ask the user to look at that tab (blue bar shows the last error) and click the bookmark again if the bar is gone.`)); }, init.timeout || 30000);
      pending.set(id, { source: x.source, origin, resolve: (v) => { note('result ' + id + ' HTTP ' + v.status); H.bus.emit('bridge-request', { id, origin, url, phase: 'done', status: v.status, ms: Date.now() - started }); resolve(v); }, reject: (e) => { note('failed ' + id + ' ' + e.message); H.bus.emit('bridge-request', { id, origin, url, phase: 'error', error: e.message }); reject(e); }, timer });
      try { x.source.postMessage({ type: 'llm-bridge-fetch', id, url, method: init.method || 'GET', headers: init.headers || {}, body: init.body }, origin); }
      catch (e) { clearTimeout(timer); pending.delete(id); b.sources.delete(x.source); reject(new Error('Bridge tab is gone: ' + e.message)); }
    });
  }

  /** bookmarklet URL: run it on a page of the target site */
  function bookmarklet() {
    // a file:// harness cannot be opened by a web page (browsers block file: URLs), and its path differs per machine:
    // make the bookmark path-free so it works everywhere and relies on the linked tab only
    const harnessUrl = myOrigin === 'null' ? '' : location.href.split('#')[0];
    const src = `(()=>{const H=${JSON.stringify(harnessUrl)},HO=${JSON.stringify(myOrigin)},T=HO==='null'?'*':HO,O=(location.origin&&location.origin!=='null')?location.origin:new URL(document.baseURI).origin;
const st=window.__llmBridge||(window.__llmBridge={});
const alive=w=>{try{return w&&!w.closed}catch(e){return false}};
if(!alive(st.w)){
 st.w=null;st.mode='';
 if(alive(window.opener)){st.w=window.opener;st.mode='opener';}
 if(!st.w&&!H){alert('LLM Harness bridge: this tab is not linked to the harness. Because the harness runs from a local file, web pages cannot open it themselves.\\n\\nIn the harness: plugin setup \\u2192 step 3 \\u2192 click "Open '+location.host+'", then click this bookmark on the tab that opens.');return;}
 if(!st.w){try{const w=window.open(H,'llm-harness');if(w){st.w=w;st.mode='popup';}}catch(e){}}
 if(!st.w){const fr=document.createElement('iframe');fr.src=H+(H.includes('#')?'':'#')+'embedded';fr.allow='clipboard-write; clipboard-read; notifications';
  fr.style.cssText='position:fixed;top:36px;right:0;width:min(560px,100%);height:calc(100% - 36px);border:0;border-left:1px solid rgba(0,0,0,.2);z-index:2147483646;background:#0b0d12;box-shadow:-6px 0 20px rgba(0,0,0,.35)';
  document.body.append(fr);st.w=fr.contentWindow;st.fr=fr;st.mode='panel';}
 st.T=T;st.ack=0;
 if(!st.listening){st.listening=1;addEventListener('message',async e=>{if(e.source!==st.w)return;const m=e.data;if(!m||typeof m!=='object')return;
  if(m.type==='llm-bridge-ping'){try{st.w.postMessage({type:'llm-bridge-pong',id:m.id},st.T||'*')}catch(err){}return;}
  if(m.type==='llm-bridge-ack'){if(!st.ack){const eo=(e.origin&&/^https?:/.test(e.origin))?e.origin:'null';if(HO!=='null'&&eo!=='null'&&eo!==HO){if(!confirm('LLM Harness bridge: this bookmark was created for '+HO+' but the linked harness tab is at '+e.origin+'. Allow it to use your '+location.host+' session?')){return;}}st.T=eo==='null'?'*':eo;st.ack=1;st.harness=(eo==='null'?'a file:// page':eo);paint();}return;}
  if(m.type!=='llm-bridge-fetch'||!st.ack||(st.T!=='*'&&e.origin!==st.T))return;
  const r={type:'llm-bridge-result',id:m.id};st.n=(st.n||0)+1;st.last='received '+(m.method||'GET')+' '+m.url.replace(O,'')+' \\u2026';paint();
  try{if(!(m.url+'/').startsWith(O+'/'))throw new Error('bridge only allows '+O);
   const h=Object.assign({},m.headers||{});const mt=document.querySelector('meta[name=csrf-token]');
   if(mt&&(m.method||'GET')!=='GET'&&!h['X-CSRF-Token'])h['X-CSRF-Token']=mt.content;
   const res=await fetch(m.url,{method:m.method||'GET',headers:h,body:m.body,credentials:'same-origin'});
   r.status=res.status;r.ok=res.ok;r.headers={};res.headers.forEach((v,k)=>r.headers[k]=v);r.body=await res.text();st.last=(m.method||'GET')+' '+m.url.replace(O,'')+' \\u2192 '+res.status;}
  catch(err){r.error=String(err&&err.message||err);st.last=(m.method||'GET')+' '+m.url.replace(O,'')+' \\u2192 ERROR '+r.error;st.err=(st.err||0)+1;console.warn('[LLM bridge]',r.error,m)}
  try{st.w.postMessage(r,st.T);}catch(err){console.warn('[LLM bridge] could not post result',err)}paint();});}
 clearInterval(st.t);const hello=()=>{try{st.w.postMessage({type:'llm-bridge-hello',origin:O,mode:st.mode},st.ack?st.T:'*')}catch(e){}};st.t=setInterval(()=>{hello();paint();},10000);setTimeout(hello,300);st.t0=Date.now();
if(!st.byeHooked){st.byeHooked=1;const bye=(r)=>{try{st.w.postMessage({type:'llm-bridge-bye',reason:r},st.T||'*')}catch(e){}};addEventListener('pagehide',()=>bye('navigation'));addEventListener('beforeunload',()=>bye('navigation'));document.addEventListener('visibilitychange',()=>{if(!document.hidden)hello();});}
}else{try{st.w.focus()}catch(e){}}
let b=document.getElementById('__llmBridgeBar');
if(!b){b=document.createElement('div');b.id='__llmBridgeBar';b.style.cssText='position:fixed;top:0;left:0;right:0;box-sizing:border-box;z-index:2147483647;background:#6d8cff;color:#fff;font:13px/1.4 sans-serif;padding:6px 12px;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,.3)';document.body.append(b);}
function paint(){const link=st.mode==='opener'?'linked to your harness tab':st.mode==='popup'?'connected to a NEW harness window (not your original tab)':'PANEL MODE: harness embedded in this page (not your original tab)';
 const state=st.ack?' \\u2713 harness at '+st.harness+' answered':(Date.now()-st.t0>6000?' \\u26A0 no answer from the harness (bookmark made for '+HO+'). Is that harness tab open at this address? Re-create the bookmark from the harness you use.':' \\u2026 waiting for the harness to answer');
 const req=st.n?' \\u00B7 requests: '+st.n+(st.err?' ('+st.err+' failed)':'')+' \\u00B7 last: '+st.last:'';
 const hint=st.mode!=='opener'?' To use your original tab: open '+location.host+' from the harness (plugin setup \\u2192 Open button) and click this bookmark there.':'';
 b.firstChild&&b.firstChild.nodeType===3?b.firstChild.textContent='LLM Harness bridge: '+link+state+req+hint+' \\u2014 keep this tab open ':b.prepend('LLM Harness bridge: '+link+state+req+hint+' \\u2014 keep this tab open ');
 b.style.background=st.ack?'#3f9d6a':(Date.now()-st.t0>6000?'#d9822b':'#6d8cff');if(st.fr)st.fr.style.top=(b.offsetHeight||36)+'px';}
paint();
if(st.fr&&!b.querySelector('[data-tg]')){const tg=document.createElement('span');tg.dataset.tg=1;tg.textContent='  \\u25E8 panel';tg.style.cssText='cursor:pointer;margin-left:12px;text-decoration:underline';tg.onclick=()=>{st.fr.style.display=st.fr.style.display==='none'?'':'none';};b.append(tg);}
if(!b.querySelector('[data-x]')){const x=document.createElement('span');x.dataset.x=1;x.textContent='  \\u2715';x.style.cssText='cursor:pointer;margin-left:12px';x.onclick=()=>{clearInterval(st.t);if(st.fr)st.fr.remove();delete window.__llmBridge;b.remove();};b.append(x);}})();`;
    return 'javascript:' + encodeURIComponent(src);
  }

  /** minimal end-to-end check: GET the site root through the bridge */
  async function ping(origin) { const r = await fetch(origin + '/', { method: 'GET', headers: {}, timeout: 15000 }); return { status: r.status, ok: r.ok, bytes: (r.body || '').length }; }
  function diagnostics() { return ['harness: ' + location.href.split('#')[0], 'origin: ' + myOrigin, 'bridges: ' + JSON.stringify(list()), 'pending: ' + pending.size, 'log:', ...log].join('\n'); }
  return { fetch, ping, has, list, health, bookmarklet, openSite, diagnostics, embedded: () => window.top !== window || location.hash.includes('embedded') };
})();
