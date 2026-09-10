/* Browser-session bridge: a bookmarklet run on a page of the target site (e.g. your Jira tab) turns that tab into a
   relay. The harness posts request descriptors to it via postMessage; the tab performs same-origin fetches with the
   user's existing login session and posts the results back. No token, no proxy, no admin, no third party.

   Security model. Messages from the harness to the site tab are always targeted at the site's origin, so only the
   genuine tab can receive them. The site tab cannot target a harness that was opened from a file (its origin is
   "null"), so the channel does not rely on origins at all: the harness owns a persistent ECDSA identity, the bookmark
   carries its public key, every session starts with a hello/ack handshake in which the harness signs a fresh AES-GCM
   key, and from then on every request and response is encrypted and authenticated with that key. A page that later
   takes over the harness window can neither read the responses nor forge a request; a bookmark made for another
   harness (different identity) is refused by the tab. Where Web Crypto is missing (plain http harness) the old
   origin-checked plaintext protocol is used, which is safe there because the origin is real. */
H.bridge = (() => {
  const bridges = new Map();   // origin -> { sources: Map<WindowProxy, {ts, mode, key?, nonce?}>, origin }
  const log = [];              // recent events for diagnostics
  const pending = new Map();   // id -> { resolve, reject, timer, source, origin }
  const myOrigin = /^https?:\/\//.test(location.origin) ? location.origin : 'null';   // file:// pages have no usable origin
  const subtle = (crypto && crypto.subtle) || null;
  const secure = !!subtle;     // can sign / encrypt (file://, https, localhost)
  let ident = null;            // { priv: CryptoKey, pub: base64 raw public key }

  /* ---- crypto helpers ---- */
  const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
  const unb64 = (s) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const te = new TextEncoder(), td = new TextDecoder();
  async function init() {
    if (!secure || ident) return ident;
    try {
      const stored = await H.db.kvGet('bridgeIdentity');
      if (stored?.priv && stored?.pub) { ident = stored; return ident; }
      const kp = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
      ident = { priv: kp.privateKey, pub: b64(await subtle.exportKey('raw', kp.publicKey)) };
      await H.db.kvSet('bridgeIdentity', ident);
    } catch (e) { note('identity unavailable: ' + e.message); ident = null; }
    return ident;
  }
  async function encrypt(key, obj) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, key, te.encode(JSON.stringify(obj)));
    return { type: 'llm-bridge-enc', iv, ct };
  }
  async function decrypt(key, m) {
    try { return JSON.parse(td.decode(await subtle.decrypt({ name: 'AES-GCM', iv: m.iv }, key, m.ct))); } catch { return null; }
  }
  /* send a protocol message to a tab: encrypted when the session has a key, plaintext otherwise */
  async function post(source, info, origin, msg) {
    source.postMessage(info?.key ? await encrypt(info.key, msg) : msg, origin);
  }

  /* ---- incoming ---- */
  async function onHello(e, m) {
    let b = bridges.get(e.origin);
    const fresh = !b;
    if (!b) { b = { sources: new Map(), origin: e.origin }; bridges.set(e.origin, b); }
    let info = b.sources.get(e.source);
    const known = !!info;
    if (!info) { info = { ts: Date.now(), mode: m.mode || '' }; b.sources.set(e.source, info); }
    info.ts = Date.now(); info.mode = m.mode || info.mode;
    const ack = { type: 'llm-bridge-ack', harness: myOrigin, url: location.href.split('#')[0] };
    if (m.nonce && secure && ident) {
      // (re)key this session: a new nonce means the bookmark was clicked again, no key means this page was reloaded
      if (!info.key || info.nonce !== m.nonce) {
        const raw = crypto.getRandomValues(new Uint8Array(32));
        info.key = await subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
        info.nonce = m.nonce; info.keyB64 = b64(raw); info.ts = Date.now();
        const ts = Date.now();
        const sig = b64(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, ident.priv, te.encode([m.nonce, e.origin, info.keyB64, ts].join('|'))));
        Object.assign(ack, { key: info.keyB64, nonce: m.nonce, ts, sig, pub: ident.pub });
      } else return;   // periodic hello on an established session: nothing to send
    } else if (myOrigin === 'null') { note('plaintext hello from ' + e.origin + ' refused: this harness has no origin; re-create the bookmark'); return; }
    try { e.source.postMessage(ack, e.origin); } catch { }   // targeted at the site origin: only the genuine tab can receive the key
    if (!known || ack.key) { note('hello from ' + e.origin + ' (' + (m.mode || '?') + (ack.key ? ', encrypted session' : ', plaintext') + ', tabs: ' + b.sources.size + ')'); H.bus.emit('bridge', list()); if (fresh) H.toast('Bridge connected: ' + e.origin, 'success'); }
  }
  function onProtocol(e, m, info) {
    if (m.type === 'llm-bridge-pong') { const p = pending.get(m.id); if (p && p.origin === e.origin && p.source === e.source) { clearTimeout(p.timer); pending.delete(m.id); p.resolve(m); } return; }
    if (m.type === 'llm-bridge-bye') {   // the tab is navigating away / closing: forget it right now
      const b = bridges.get(e.origin); if (b && b.sources.has(e.source)) { b.sources.delete(e.source); note('tab left ' + e.origin + ' (' + (m.reason || 'navigation') + ')'); if (!b.sources.size) bridges.delete(e.origin); H.bus.emit('bridge', list()); if (/mismatch/.test(m.reason || '')) H.toast(`Bridge to ${e.origin} refused: ${m.reason}.`, 'warn', 10000); else if (!b.sources.size) H.toast(`Bridge to ${e.origin} lost: the tab navigated or closed. Click the bookmark on it again.`, 'warn', 8000); }
      return;
    }
    if (m.type === 'llm-bridge-result') {
      const p = pending.get(m.id); if (!p) { note('result for unknown request ' + m.id + ' from ' + e.origin); return; }
      if (p.origin !== e.origin || p.source !== e.source) { note('result from an unexpected tab ignored (' + e.origin + ')'); return; }
      clearTimeout(p.timer); pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error)); else p.resolve(m);
    }
  }
  window.addEventListener('message', async (e) => {
    const m = e.data; if (!m || typeof m !== 'object' || !/^https?:\/\//.test(e.origin)) return;   // e.origin is set by the browser and cannot be spoofed
    if (m.type === 'llm-bridge-hello') return onHello(e, m);
    const info = bridges.get(e.origin)?.sources.get(e.source);
    if (!info) return;                                     // only tabs that said hello
    if (m.type === 'llm-bridge-enc') { if (!info.key) return; const inner = await decrypt(info.key, m); if (inner) onProtocol(e, inner, info); else note('undecryptable message from ' + e.origin + ' ignored'); return; }
    if (m.type === 'llm-bridge-bye') return onProtocol(e, m, info);   // may arrive in plaintext during unload; harmless (drops a tab)
    if (info.key || myOrigin === 'null') return;           // an encrypted session accepts nothing in plaintext
    onProtocol(e, m, info);
  });
  // liveness: a source stays registered until its window is closed, it says goodbye, or a probe/request fails.
  setInterval(() => {
    let changed = false;
    for (const [o, b] of bridges) { for (const [src] of b.sources) if (isClosed(src)) { b.sources.delete(src); changed = true; } if (!b.sources.size) { bridges.delete(o); changed = true; } }
    if (changed) H.bus.emit('bridge', list());
  }, 5000);
  /** ask one tab to answer immediately (message events are not throttled in background tabs) */
  function probe(source, info, origin, timeout = 3000) {
    const id = H.uid();
    return new Promise((resolve) => {
      const timer = setTimeout(() => { pending.delete(id); resolve(false); }, timeout);
      pending.set(id, { source, origin, resolve: () => resolve(true), reject: () => resolve(false), timer });
      post(source, info, origin, { type: 'llm-bridge-ping', id }).catch(() => { clearTimeout(timer); pending.delete(id); resolve(false); });
    });
  }
  /** find a responsive tab for an origin, dropping dead ones; returns { source, info } or null */
  async function alive(origin) {
    const b = bridges.get(origin); if (!b) return null;
    const cands = [...b.sources.entries()].filter(([src]) => !isClosed(src)).sort((x, y) => y[1].ts - x[1].ts);
    for (const [src, info] of cands) {
      if (Date.now() - info.ts < 8000 || await probe(src, info, origin)) { info.ts = Date.now(); return { source: src, info }; }
      b.sources.delete(src); note('dropped unresponsive tab for ' + origin);
    }
    if (!b.sources.size) bridges.delete(origin);
    H.bus.emit('bridge', list());
    return null;
  }
  function isClosed(w) { try { return !!w.closed; } catch { return false; } }
  function note(t) { log.push(new Date().toLocaleTimeString() + ' ' + t); if (log.length > 40) log.shift(); }
  function best(b) { let s = null, bi = null; for (const [src, info] of b.sources) if (!isClosed(src) && (!bi || info.ts > bi.ts)) { s = src; bi = info; } return s ? { source: s, info: bi } : null; }

  function list() { return [...bridges.values()].map(b => { const x = best(b); return { origin: b.origin, tabs: b.sources.size, age: x ? Date.now() - x.info.ts : 0, mode: x ? x.info.mode : '', encrypted: !!x?.info.key }; }); }
  /** UI helper: probe every bridge, returns list with `ok` flags */
  async function health() { const out = []; for (const b of [...bridges.values()]) { const x = await alive(b.origin); out.push({ origin: b.origin, ok: !!x, tabs: b.sources.size, mode: x?.info.mode || '', encrypted: !!x?.info.key }); } return out; }
  /** open the target site from the harness so the new tab keeps window.opener (lets the bookmarklet link back without a popup) */
  function openSite(url) { try { const w = window.open(url, '_blank'); if (!w) H.toast('The browser blocked opening the tab. Open the site manually, the bookmarklet will fall back to panel mode.', 'warn', 7000); return w; } catch { return null; } }
  function has(url) { try { return bridges.has(new URL(url).origin); } catch { return false; } }

  /** the bridge can work here: a real origin (plaintext fallback) or a signing identity (encrypted sessions) */
  const usable = () => myOrigin !== 'null' || !!ident;
  /** fetch through the bridge of url's origin; resolves to { status, ok, headers, body } */
  async function fetch(url, init = {}) {
    if (!usable()) throw new Error('The browser session bridge is not available: this harness was opened from a file and could not create its signing identity (Web Crypto or IndexedDB unavailable). Host the harness on an http(s) address or use another browser.');
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
      if (init.signal?.aborted) return reject(Object.assign(new Error('Cancelled by the user (Stop).'), { name: 'AbortError' }));
      init.signal?.addEventListener('abort', () => { const p = pending.get(id); if (!p) return; clearTimeout(p.timer); pending.delete(id); note('cancelled ' + id); H.bus.emit('bridge-request', { id, origin, url, phase: 'cancelled' }); reject(Object.assign(new Error('Cancelled by the user (Stop).'), { name: 'AbortError' })); }, { once: true });
      const timer = setTimeout(() => { pending.delete(id); note('timeout ' + id); b.sources.delete(x.source); H.bus.emit('bridge', list()); H.bus.emit('bridge-request', { id, origin, url, phase: 'timeout' }); reject(new Error(`Bridge request timed out after ${Math.round((init.timeout || 30000) / 1000)} s: the ${origin} tab did not answer. It may be on a login page, blocked by a dialog, or asleep. Ask the user to look at that tab (blue bar shows the last error) and click the bookmark again if the bar is gone.`)); }, init.timeout || 30000);
      pending.set(id, { source: x.source, origin, resolve: (v) => { note('result ' + id + ' HTTP ' + v.status); H.bus.emit('bridge-request', { id, origin, url, phase: 'done', status: v.status, ms: Date.now() - started }); resolve(v); }, reject: (e) => { note('failed ' + id + ' ' + e.message); H.bus.emit('bridge-request', { id, origin, url, phase: 'error', error: e.message }); reject(e); }, timer });
      post(x.source, x.info, origin, { type: 'llm-bridge-fetch', id, url, method: init.method || 'GET', headers: init.headers || {}, body: init.body })
        .catch((e) => { clearTimeout(timer); pending.delete(id); b.sources.delete(x.source); reject(new Error('Bridge tab is gone: ' + e.message)); });
    });
  }

  /** bookmarklet URL: run it on a page of the target site */
  function bookmarklet() {
    if (myOrigin === 'null' && !ident) return 'javascript:alert("The LLM Harness bridge could not create its signing identity in this browser (Web Crypto or IndexedDB unavailable). Host the harness on an http(s) address.")';
    // a file:// harness cannot be opened by a web page (browsers block file: URLs), and its path differs per machine:
    // make the bookmark path-free so it works everywhere and relies on the linked tab only
    const harnessUrl = myOrigin === 'null' ? '' : location.href.split('#')[0];
    const pub = ident ? ident.pub : '';
    const src = `(()=>{const H=${JSON.stringify(harnessUrl)},HO=${JSON.stringify(myOrigin)},PK=${JSON.stringify(pub)},T=HO==='null'?'*':HO,O=(location.origin&&location.origin!=='null')?location.origin:new URL(document.baseURI).origin;
const st=window.__llmBridge||(window.__llmBridge={});
const alive=w=>{try{return w&&!w.closed}catch(e){return false}};
const S=(crypto&&crypto.subtle)||null;
if(PK&&!S){alert('LLM Harness bridge: this page ('+O+') is not a secure context, so the encrypted bridge cannot run here.');return;}
const u8=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));const enc=new TextEncoder(),dec=new TextDecoder();
const send=async m=>{try{if(st.key){const iv=crypto.getRandomValues(new Uint8Array(12));const ct=await S.encrypt({name:'AES-GCM',iv},st.key,enc.encode(JSON.stringify(m)));st.w.postMessage({type:'llm-bridge-enc',iv,ct},T);}else if(!PK){st.w.postMessage(m,st.T||HO);}}catch(e){console.warn('[LLM bridge] could not post',e)}};
if(!alive(st.w)){
 st.w=null;st.mode='';
 if(alive(window.opener)){st.w=window.opener;st.mode='opener';}
 if(!st.w&&!H){alert('LLM Harness bridge: this tab is not linked to the harness. Because the harness runs from a local file, web pages cannot open it themselves.\\n\\nIn the harness: plugin setup \\u2192 step 3 \\u2192 click "Open '+location.host+'", then click this bookmark on the tab that opens.');return;}
 if(!st.w){try{const w=window.open(H,'llm-harness');if(w){st.w=w;st.mode='popup';}}catch(e){}}
 if(!st.w){const fr=document.createElement('iframe');fr.src=H+(H.includes('#')?'':'#')+'embedded';fr.allow='clipboard-write; clipboard-read; notifications';
  fr.style.cssText='position:fixed;top:36px;right:0;width:min(560px,100%);height:calc(100% - 36px);border:0;border-left:1px solid rgba(0,0,0,.2);z-index:2147483646;background:#0b0d12;box-shadow:-6px 0 20px rgba(0,0,0,.35)';
  document.body.append(fr);st.w=fr.contentWindow;st.fr=fr;st.mode='panel';}
 st.T=T;st.ack=0;st.key=null;st.bad=0;st.nonce=PK?btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16)))):'';
 const handle=async(e,m)=>{
  if(m.type==='llm-bridge-ping'){send({type:'llm-bridge-pong',id:m.id});return;}
  if(m.type!=='llm-bridge-fetch')return;
  const r={type:'llm-bridge-result',id:m.id};st.n=(st.n||0)+1;st.last='received '+(m.method||'GET')+' '+m.url.replace(O,'')+' \\u2026';paint();
  try{if(!(m.url+'/').startsWith(O+'/'))throw new Error('bridge only allows '+O);
   const h=Object.assign({},m.headers||{});const mt=document.querySelector('meta[name=csrf-token]');
   if(mt&&(m.method||'GET')!=='GET'&&!h['X-CSRF-Token'])h['X-CSRF-Token']=mt.content;
   const res=await fetch(m.url,{method:m.method||'GET',headers:h,body:m.body,credentials:'same-origin'});
   r.status=res.status;r.ok=res.ok;r.headers={};res.headers.forEach((v,k)=>r.headers[k]=v);r.body=await res.text();st.last=(m.method||'GET')+' '+m.url.replace(O,'')+' \\u2192 '+res.status;}
  catch(err){r.error=String(err&&err.message||err);st.last=(m.method||'GET')+' '+m.url.replace(O,'')+' \\u2192 ERROR '+r.error;st.err=(st.err||0)+1;console.warn('[LLM bridge]',r.error,m)}
  await send(r);paint();};
 if(!st.listening){st.listening=1;addEventListener('message',async e=>{if(e.source!==st.w)return;const m=e.data;if(!m||typeof m!=='object')return;
  if(m.type==='llm-bridge-ack'){const eo=(e.origin&&/^https?:/.test(e.origin))?e.origin:'null';
   if(PK){try{if(m.nonce!==st.nonce||!m.sig||!m.key)return;const vk=await S.importKey('raw',u8(PK),{name:'ECDSA',namedCurve:'P-256'},false,['verify']);
    const ok=await S.verify({name:'ECDSA',hash:'SHA-256'},vk,u8(m.sig),enc.encode([m.nonce,O,m.key,m.ts].join('|')));
    if(!ok){st.bad=1;paint();try{st.w.postMessage({type:'llm-bridge-bye',reason:'identity mismatch: this bookmark was made for another harness; re-create it'},T)}catch(e){}return;}
    if(eo!==HO&&!st.ack){if(!confirm('LLM Harness bridge: this bookmark was created for '+HO+' but the linked harness tab is at '+e.origin+'. Allow it to use your '+location.host+' session?')){return;}}
    st.key=await S.importKey('raw',u8(m.key),'AES-GCM',false,['encrypt','decrypt']);st.bad=0;}catch(err){console.warn('[LLM bridge] ack rejected',err);return;}}
   else{if(!st.ack&&eo!==HO){if(!confirm('LLM Harness bridge: this bookmark was created for '+HO+' but the linked harness tab is at '+e.origin+'. Allow it to use your '+location.host+' session?')){return;}}st.T=eo;}
   st.ack=1;st.harness=eo;paint();return;}
  if(!st.ack)return;
  if(PK){if(m.type!=='llm-bridge-enc'||!st.key)return;let inner;try{inner=JSON.parse(dec.decode(await S.decrypt({name:'AES-GCM',iv:m.iv},st.key,m.ct)));}catch(err){return;}return handle(e,inner);}
  if(e.origin!==st.T)return;return handle(e,m);});}
 clearInterval(st.t);const hello=()=>{try{st.w.postMessage({type:'llm-bridge-hello',origin:O,mode:st.mode,nonce:st.nonce},T)}catch(e){}};st.t=setInterval(()=>{hello();paint();},10000);setTimeout(hello,300);st.t0=Date.now();
if(!st.byeHooked){st.byeHooked=1;const bye=(r)=>{try{st.w.postMessage({type:'llm-bridge-bye',reason:r},T)}catch(e){}};addEventListener('pagehide',()=>bye('navigation'));addEventListener('beforeunload',()=>bye('navigation'));document.addEventListener('visibilitychange',()=>{if(!document.hidden)hello();});}
}else{try{st.w.focus()}catch(e){}}
let b=document.getElementById('__llmBridgeBar');
if(!b){b=document.createElement('div');b.id='__llmBridgeBar';b.style.cssText='position:fixed;top:0;left:0;right:0;box-sizing:border-box;z-index:2147483647;background:#6d8cff;color:#fff;font:13px/1.4 sans-serif;padding:6px 12px;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,.3)';document.body.append(b);}
function paint(){const link=st.mode==='opener'?'linked to your harness tab':st.mode==='popup'?'connected to a NEW harness window (not your original tab)':'PANEL MODE: harness embedded in this page (not your original tab)';
 const state=st.bad?' \\u2716 the harness that answered is not the one this bookmark was made for (identity mismatch). Re-create the bookmark from the harness you use.':st.ack?' \\u2713 harness'+(st.key?' (encrypted)':'')+' at '+st.harness+' answered':(Date.now()-st.t0>6000?' \\u26A0 no answer from the harness (bookmark made for '+HO+'). Is that harness tab open at this address? Re-create the bookmark from the harness you use.':' \\u2026 waiting for the harness to answer');
 const req=st.n?' \\u00B7 requests: '+st.n+(st.err?' ('+st.err+' failed)':'')+' \\u00B7 last: '+st.last:'';
 const hint=st.mode!=='opener'?' To use your original tab: open '+location.host+' from the harness (plugin setup \\u2192 Open button) and click this bookmark there.':'';
 b.firstChild&&b.firstChild.nodeType===3?b.firstChild.textContent='LLM Harness bridge: '+link+state+req+hint+' \\u2014 keep this tab open ':b.prepend('LLM Harness bridge: '+link+state+req+hint+' \\u2014 keep this tab open ');
 b.style.background=st.bad?'#c0392b':st.ack?'#3f9d6a':(Date.now()-st.t0>6000?'#d9822b':'#6d8cff');if(st.fr)st.fr.style.top=(b.offsetHeight||36)+'px';}
paint();
if(st.fr&&!b.querySelector('[data-tg]')){const tg=document.createElement('span');tg.dataset.tg=1;tg.textContent='  \\u25E8 panel';tg.style.cssText='cursor:pointer;margin-left:12px;text-decoration:underline';tg.onclick=()=>{st.fr.style.display=st.fr.style.display==='none'?'':'none';};b.append(tg);}
if(!b.querySelector('[data-ka]')){const ka=document.createElement('span');ka.dataset.ka=1;ka.style.cssText='cursor:pointer;margin-left:12px;text-decoration:underline';const paintKa=()=>{ka.textContent=st.ka?'  \\u266B keep awake: on':'  \\u266B keep awake';};paintKa();
ka.onclick=()=>{if(st.ka){try{st.ka.osc.stop();st.ka.ctx.close();}catch(e){}st.ka=null;paintKa();return;}try{const ctx=new (window.AudioContext||window.webkitAudioContext)();const osc=ctx.createOscillator();const g=ctx.createGain();osc.type='sine';osc.frequency.value=19500;g.gain.value=0.02;osc.connect(g);g.connect(ctx.destination);osc.start();st.ka={ctx,osc};paintKa();}catch(e){alert('Could not start keep-awake audio: '+e.message);}};b.append(ka);}
if(!b.querySelector('[data-x]')){const x=document.createElement('span');x.dataset.x=1;x.textContent='  \\u2715';x.style.cssText='cursor:pointer;margin-left:12px';x.onclick=()=>{clearInterval(st.t);if(st.fr)st.fr.remove();if(st.ka){try{st.ka.osc.stop();st.ka.ctx.close();}catch(e){}}delete window.__llmBridge;b.remove();};b.append(x);}})();`;
    return 'javascript:' + encodeURIComponent(src);
  }
  /** the bookmarklet code as plain JS (for tests and the extension) */
  const bookmarkletSource = () => decodeURIComponent(bookmarklet().slice('javascript:'.length));

  /** minimal end-to-end check: GET the site root through the bridge */
  async function ping(origin) { const r = await fetch(origin + '/', { method: 'GET', headers: {}, timeout: 15000 }); return { status: r.status, ok: r.ok, bytes: (r.body || '').length }; }
  function diagnostics() { return ['harness: ' + location.href.split('#')[0], 'origin: ' + myOrigin, 'identity: ' + (ident ? ident.pub.slice(0, 16) + '…' : 'none') + (secure ? '' : ' (no Web Crypto: plaintext protocol)'), 'bridges: ' + JSON.stringify(list()), 'pending: ' + pending.size, 'log:', ...log].join('\n'); }
  return { fetch, ping, has, list, health, bookmarklet, bookmarkletSource, openSite, diagnostics, usable, init, identity: () => ident, embedded: () => window.top !== window || location.hash.includes('embedded') };
})();
