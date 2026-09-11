/* UI: sidebar, messages, composer, settings, plugin setup, preview panel */
H.ui = (() => {
  const $ = H.$, el = H.el;
  let attachments = [];
  let slashIdx = -1;
  const drafts = new Map();   // chatId -> unsent text

  /* ---------------- markdown ---------------- */
  /* Images are never fetched on render: a remote <img> in a reply would be a silent GET carrying whatever the model put
     in the URL. Markdown images become click-to-load placeholders (inline data:/blob: images load immediately); raw
     <img> tags are stripped by the sanitizer. */
  let mdReady = false;
  function mdInit() {
    if (mdReady || !window.marked) return; mdReady = true;
    const image = (href, title, text) => {
      if (href && typeof href === 'object') ({ href, title, text } = href);
      return `<span class="md-img" data-src="${H.esc(href || '')}" data-alt="${H.esc(text || '')}" title="${H.esc(title || '')}"></span>`;
    };
    try { marked.use({ renderer: { image } }); } catch { }
  }
  const IMG_OK = /^(https?:\/\/|data:image\/|blob:)/i;
  function loadImage(ph, { auto } = {}) {
    const src = ph.dataset.src || '', alt = ph.dataset.alt || '';
    if (!IMG_OK.test(src)) { ph.textContent = `[image: ${alt || 'invalid URL'}]`; ph.classList.add('dead'); return; }
    const inline = /^(data:|blob:)/i.test(src);
    if (auto && !inline) {
      let host = ''; try { host = new URL(src).host; } catch { }
      ph.replaceChildren(H.icon('download'), el('span', {}, [alt ? `${alt} · ` : '', `load image from ${host}`]));
      ph.setAttribute('role', 'button'); ph.tabIndex = 0;
      const go = () => loadImage(ph, {});
      ph.onclick = go; ph.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } };
      return;
    }
    const img = el('img', { src, alt, title: ph.title || null });
    img.onerror = () => { ph.textContent = `[image failed to load: ${alt || src}]`; ph.classList.add('dead'); img.replaceWith(ph); };
    ph.replaceWith(img);
  }
  function md(text) {
    if (!text) return '';
    let html;
    // fail closed: without the sanitizer, never insert model-authored HTML; show escaped text instead
    if (!window.DOMPurify || !window.marked) return '<p>' + H.esc(text).replace(/\n/g, '<br>') + '</p>';
    mdInit();
    try { html = marked.parse(text, { breaks: true, gfm: true }); } catch { return '<p>' + H.esc(text).replace(/\n/g, '<br>') + '</p>'; }
    return DOMPurify.sanitize(html, { ADD_ATTR: ['target'], FORBID_TAGS: ['style', 'form', 'input', 'button', 'img', 'picture', 'source', 'video', 'audio', 'iframe', 'object', 'embed', 'link', 'meta'], FORBID_ATTR: ['style', 'onerror', 'onload', 'srcset', 'poster', 'background'] });
  }
  const mdBlock = (text) => { const d = el('div', { class: 'md', html: md(text) }); enhanceCode(d, { highlight: false }); return d; };
  function enhanceCode(root, { highlight = true } = {}) {
    root.querySelectorAll('pre').forEach(pre => {
      if (pre.parentElement?.classList.contains('codeblock')) return;
      const code = pre.querySelector('code');
      const lang = (code?.className.match(/language-([\w+-]+)/) || [])[1] || '';
      if (highlight && code && window.hljs && !code.dataset.hl && code.textContent.length < 30000) { try { hljs.highlightElement(code); code.dataset.hl = '1'; } catch { } }
      const wrap = el('div', { class: 'codeblock' });
      pre.replaceWith(wrap);
      const copy = el('button', { class: 'btn sm ghost', onclick: () => { navigator.clipboard.writeText(code ? code.innerText : pre.innerText); copy.textContent = 'Copied'; setTimeout(() => copy.textContent = 'Copy', 1200); } }, ['Copy']);
      wrap.append(el('div', { class: 'codebar' }, [el('span', { class: 'lang' }, [lang || 'text']), el('span', { class: 'spacer' }), copy]), pre);
    });
    root.querySelectorAll('a[href]').forEach(a => { a.target = '_blank'; a.rel = 'noopener'; });
    root.querySelectorAll('.md-img:not([data-ready])').forEach(ph => { ph.dataset.ready = '1'; loadImage(ph, { auto: true }); });
  }

  /* ---------------- messages ---------------- */
  const nodeFor = new Map();
  const WINDOW = 120;   // messages rendered initially; older ones on demand (a long tool-heavy chat can hold thousands)
  let renderFrom = 0;
  function renderChat(chat, { from } = {}) {
    const box = $('#messages'); box.innerHTML = ''; nodeFor.clear(); turnOf.clear(); closeTurn();
    const wrap = el('div', { class: 'msg-wrap' }); box.append(wrap);
    if (!chat || !chat.messages.length) { wrap.append(emptyState()); updateContextMeter(); return; }
    const msgs = chat.messages;
    let start = from ?? Math.max(0, msgs.length - WINDOW);
    while (start > 0 && msgs[start].role !== 'user') start--;   // start at a turn boundary so responses are never split
    renderFrom = start;
    if (start > 0) wrap.append(el('div', { class: 'load-earlier' }, [el('button', { class: 'btn sm', onclick: () => { const keep = box.scrollHeight - box.scrollTop; renderChat(chat, { from: Math.max(0, start - WINDOW) }); box.scrollTop = box.scrollHeight - keep; } }, [`Show earlier messages (${start} hidden)`])]));
    for (let i = start; i < msgs.length; i++) placeMessage(wrap, msgs[i], i);
    if (from === undefined) scrollBottom(true);
    updateContextMeter();
  }
  function emptyState() {
    const tips = [
      ['folder', 'Explore a workspace', 'Open a folder with the folder button under the message box, then ask the model to list and summarize the project.', 'List the files in the workspace and summarize what this project does.'],
      ['code', 'Run code', 'Python (Pyodide) and JavaScript run in a sandbox right in the browser.', 'Use python to compute the first 20 primes and plot them as an ASCII chart.'],
      ['bolt', 'Plan first', 'Switch to Plan mode: the model investigates read-only, proposes a plan, and you decide whether to execute it.', 'Plan how to add unit tests to this project.'],
      ['plug', 'Use plugins', 'Set up Jira or GitHub in Plugins, then ask about issues and pull requests.', 'What are my open Jira issues? Group them by status.'],
    ];
    return el('div', { id: 'empty' }, [
      el('h2', {}, ['What are we working on?']),
      el('p', {}, ['Chat, tools, skills and plugins. Everything runs in your browser, straight against your LiteLLM proxy.']),
      connectionsStrip(),
      el('div', { class: 'tips' }, tips.map(([ic, t, d, prompt]) => el('div', { class: 'tip', onclick: () => { $('#input').value = prompt; autoresize(); $('#input').focus(); } }, [el('div', { class: 'ti' }, [H.icon(ic)]), el('div', {}, [el('b', {}, [t]), el('div', { class: 'small muted' }, [d])])]))),
    ]);
  }
  /* ---------------- connections (plugins) status ---------------- */
  function pluginStatus(p) {
    if (!p.enabled) return { state: 'off', label: 'off' };
    const origin = (() => { try { return new URL(p.kind === 'mcp' ? (p.url || H.settings.get('baseUrl')) : p.baseUrl).origin; } catch { return ''; } })();
    const r = p.route?.type || 'direct';
    if (r === 'bridge') {
      const old = H.bridge.legacy(origin);
      if (old) return { state: 'warn', label: old === 'refused' ? 'old bridge bookmark: re-create it (Set up › step 3)' : 'connected with an old bookmark (unencrypted): re-create it', legacy: true };
      return H.bridge.has(origin) ? { state: 'on', label: 'bridge connected' } : { state: 'warn', label: 'bridge not connected' };
    }
    if (r === 'extension') return H.ext.available() ? { state: 'on', label: 'via extension' } : { state: 'warn', label: 'extension missing' };
    if (p.useLitellmKey) return H.settings.apiKey() ? { state: 'on', label: 'via LiteLLM' } : { state: 'warn', label: 'no API key' };
    return { state: 'on', label: r === 'direct' ? 'direct' : r === 'litellm' ? 'via LiteLLM' : 'via proxy' };
  }
  /* one-click reconnect for a bridge plugin: open the site linked to this tab and tell the user what to click */
  function reconnect(p) {
    const origin = (() => { try { return new URL(p.baseUrl || p.url).origin; } catch { return null; } })();
    if (!origin) return openSettings('plugins');
    const w = H.bridge.openSite(origin);
    const box = $('#toasts'); box.querySelectorAll('.reconnect-toast').forEach(t => t.remove());
    const t = el('div', { class: 'toast reconnect-toast' }, [
      el('div', {}, [el('b', {}, [w ? `${origin.replace(/^https?:\/\//, '')} opened in a new tab` : 'The browser blocked the new tab']), el('div', { class: 'small muted' }, [w ? 'On that tab, click the "LLM Harness bridge" bookmark. This notice closes by itself once connected.' : `Open ${origin} yourself from this button's tooltip and click the bookmark there.`])]),
      el('div', { class: 'row gap', style: 'margin-top:8px' }, [
        el('button', { class: 'btn sm', onclick: () => { navigator.clipboard.writeText(H.bridge.bookmarklet()); H.toast('Bookmark address copied: create a bookmark and paste it as the address.', 'success', 6000); } }, ['No bookmark yet? Copy it']),
        el('button', { class: 'btn sm ghost', onclick: () => t.remove() }, ['Close']),
      ]),
    ]);
    box.append(t);
    const off = H.bus.on('bridge', () => { if (H.bridge.has(origin)) { t.remove(); off(); H.toast(`${shortName(p)} connected ✓`, 'success', 3000); } });
    setTimeout(() => { t.remove(); off(); }, 120000);
  }
  const shortName = (p) => ({ jira: 'Jira Cloud', jira2: 'Jira Server', git: 'GitHub', gitlab: 'GitLab', 'litellm-mcp': 'LiteLLM MCP' })[p.id] || p.name.replace(/ \(.*\)$/, '');
  function connectionsStrip() {
    const box = el('div', { class: 'connections' });
    const paint = () => {
      box.innerHTML = '';
      const list = H.plugins.list().filter(p => p.enabled);
      if (!list.length) { box.classList.add('hidden'); return; }   // nothing enabled: no strip at all
      box.classList.remove('hidden');
      box.append(el('span', { class: 'conn-label' }, ['Connections']));
      for (const p of list) {
        const s = pluginStatus(p);
        const canReconnect = s.state === 'warn' && !s.legacy && (p.route?.type || 'direct') === 'bridge';
        box.append(el('button', { class: 'conn ' + s.state + (canReconnect ? ' action' : ''), title: canReconnect ? `${p.name}: bridge not connected. Click to open the site in a linked tab, then click the bookmark there.` : `${p.name}: ${s.label}. Click to configure.`, onclick: () => canReconnect ? reconnect(p) : openSettings('plugins') }, [el('span', { class: 'dot' }), shortName(p), el('span', { class: 'conn-state' }, [canReconnect ? 'reconnect ↗' : s.label])]));
      }

    };
    paint();
    const off = [H.bus.on('bridge', paint), H.bus.on('plugins', paint), H.bus.on('ext', paint), H.bus.on('settings', paint)];
    const iv = setInterval(() => { if (!document.body.contains(box)) { off.forEach(f => f()); clearInterval(iv); } else paint(); }, 5000);
    return box;
  }
  function updateConnPill() {
    const pill = $('#bridge-pill');
    const enabled = H.plugins.list().filter(p => p.enabled);
    if (!enabled.length) { pill.classList.add('hidden'); return; }
    const st = enabled.map(p => ({ p, s: pluginStatus(p) }));
    const bad = st.filter(x => x.s.state === 'warn');
    pill.classList.remove('hidden'); pill.className = 'conn-pill ' + (bad.length ? 'warn' : 'on'); pill.innerHTML = '';
    pill.append(el('span', { class: 'dot' }), bad.length ? `${bad.length} of ${enabled.length} not connected` : `${enabled.length} connected`);
    pill.title = st.map(x => `${shortName(x.p)}: ${x.s.label}`).join('\n') + '\nClick to check / configure.';
  }
  /* ===== Rendering model =====
     A user message is one element. An assistant *turn* (everything the assistant does until the next user message:
     text, tool calls, more text, a plan) is ONE element: a body made of parts, then a footer (time, tokens/cost, Copy, Retry).
     Hover, copy and retry therefore apply to the whole response. */
  let openTurn = null;                       // the turn currently receiving parts (closed by any user message)
  const turnOf = new Map();                  // part node -> turn
  function closeTurn() { openTurn = null; }

  function userNode(m, idx) {
    if (m.meta?.summary) {
      const det = el('details', { class: 'summary-card' }, [el('summary', {}, [H.icon('bolt'), el('b', {}, ['Earlier conversation compacted']), el('span', { class: 'muted small' }, [` · ${m.meta.replaces} messages summarised; the model sees this summary instead`])]), mdBlock(m.content.replace(/^\[[^\]]*\]\n/, ''))]);
      return det;
    }
    const node = el('div', { class: 'msg user' + (m.meta?.planExec ? ' plan-exec' : '') + (m.meta?.system ? ' system' : '') + (m.meta?.compacted ? ' compacted' : '') }, [el('div', { class: 'body' }, [
      el('div', { class: 'role' }, [el('span', { class: 'actions' }, [
        el('button', { class: 'btn sm ghost', title: 'Copy', onclick: () => { navigator.clipboard.writeText(m.display || (typeof m.content === 'string' ? m.content : '')); H.toast('Copied', 'success', 1200); } }, ['Copy']),
        el('button', { class: 'btn sm ghost icon', title: 'Delete', onclick: () => H.agent.deleteMessage(idx) }, [H.icon('x')])]), el('span', { class: 'muted small ts', title: H.fmtTime(m.ts) }, [H.fmtClock(m.ts)])]),
      el('div', { class: 'text' }, [m.display || (typeof m.content === 'string' ? m.content : '')]),
      m.attachments?.length ? el('div', { class: 'attachments' }, m.attachments.map(a => el('span', { class: 'chip' + (a.empty ? ' risk-danger' : ''), title: a.empty ? 'No text could be extracted from this file; the model cannot read it. ' + (a.note || '') : (a.chars ? `${a.chars.toLocaleString()} characters of text were sent to the model` : '') }, [H.icon('clip'), `${a.name} (${H.fmtBytes(a.size || 0)})`, a.empty ? ' · no text!' : '']))) : null,
    ])]);
    return node;
  }
  function newTurn(firstMsg) {
    const body = el('div', { class: 'body' });
    const stats = el('span', { class: 'muted small stats' });
    const node = el('div', { class: 'msg assistant turn' }, [el('div', { class: 'tbody-wrap' }, [
      el('div', { class: 'role' }, [el('span', { class: 'name' }, ['Assistant']), el('span', { class: 'muted small ts', title: H.fmtTime(firstMsg.ts) }, [H.fmtClock(firstMsg.ts)]), stats, el('span', { class: 'spacer' }), el('span', { class: 'actions' }, [
        el('button', { class: 'btn sm ghost', title: 'Copy the whole response (markdown)', onclick: () => { navigator.clipboard.writeText(turn.msgs.filter(x => x.role === 'assistant' && x.content).map(x => x.content).join('\n\n')); H.toast('Response copied', 'success', 1200); } }, ['Copy']),
        el('button', { class: 'btn sm ghost', title: 'Regenerate this response', onclick: () => H.agent.regenerate() }, ['Retry']),
      ])]),
      body,
    ])]);
    const turn = { node, body, stats, msgs: [] };
    return turn;
  }
  function updateTurnStats(turn) {
    let p = 0, c = 0, cost = 0, known = false;
    let cached = 0;
    for (const m of turn.msgs) { const u = m.meta?.usage; if (!u) continue; p += u.prompt_tokens || 0; c += u.completion_tokens || 0; cached += H.usage.cachedOf(u); const k = H.usage.costOfUsage(m.meta.model || H.settings.get('model'), u); if (k != null) { cost += k; known = true; } }
    turn.stats.textContent = (p || c) ? `· ${H.usage.fmtTok(p)} in${cached ? ` (${H.usage.fmtTok(cached)} cached)` : ''} / ${H.usage.fmtTok(c)} out` + (known && H.settings.get('showCost') ? ` · ${H.usage.fmtCost(cost)}` : '') : '';
  }
  function assistantPart(m) {
    return el('div', { class: 'part text' }, [
      el('div', { class: 'reasoning-slot' }), el('div', { class: 'thinking hidden' }, [el('span'), el('span'), el('span')]), el('div', { class: 'md content' }), el('div', { class: 'tc-slot' }), el('div', { class: 'err-slot' }), el('div', { class: 'plan-slot' }),
    ]);
  }
  function toolPart(m) {
    return el('details', { class: 'tool-card' }, [el('summary', {}, [el('span', { class: 'tstate' }), el('span', { class: 'tname' }, [m.name]), el('span', { class: 'targs' }), el('span', { class: 'tactions' })]), el('div', { class: 'tbody' })]);
  }
  /* place a message into the DOM (returns nothing; appends to wrap or to the open turn) */
  function placeMessage(wrap, m, idx) {
    if (m.role === 'user') { closeTurn(); wrap.append(userNode(m, idx)); return; }
    if (m.role !== 'assistant' && m.role !== 'tool') return;
    if (!openTurn) { openTurn = newTurn(m); wrap.append(openTurn.node); }
    const turn = openTurn;
    if (m.meta?.compacted) turn.node.classList.add('compacted');
    const part = m.role === 'assistant' ? assistantPart(m) : toolPart(m);
    const prevPart = turn.body.lastElementChild;
    if (m.role === 'tool') part.classList.toggle('first', !prevPart || !prevPart.classList.contains('tool-card'));
    turn.body.append(part); turn.msgs.push(m); nodeFor.set(m, part); turnOf.set(part, turn);
    if (m.role === 'assistant') updateAssistant(part, m); else updateTool(part, m);
  }
  function updateAssistant(node, m) {
    const c = node.querySelector('.content');
    const streaming = !!m.meta?.streaming;
    // re-render markdown only when the text changed; while streaming, skip syntax highlighting (done once at the end)
    const key = (m.content || '') + '\u0000' + (streaming ? 's' : 'f');
    if (node._key !== key) {
      node._key = key;
      c.innerHTML = md(m.content);
      enhanceCode(c, { highlight: !streaming });
    }
    c.classList.toggle('cursor', streaming && !!m.content && !m.tool_calls?.length);
    node.querySelector('.thinking').classList.toggle('hidden', !(streaming && !m.content && !m.reasoning && !m.tool_calls?.length));
    node.classList.toggle('blank', !m.content && !streaming && !m.meta?.error && !m.reasoning);   // e.g. a turn that goes straight to a tool call
    const rs = node.querySelector('.reasoning-slot');
    const rkey = m.reasoning || '';
    if (rs._key !== rkey) { rs._key = rkey; rs.innerHTML = ''; if (m.reasoning) rs.append(el('details', { class: 'reasoning' }, [el('summary', {}, ['Reasoning']), mdBlock(m.reasoning)])); }
    const tcs = node.querySelector('.tc-slot'); tcs.innerHTML = '';
    if (m.meta?.streaming && m.tool_calls?.length) tcs.append(el('div', { class: 'muted small' }, [el('span', { class: 'spinner' }), ' Calling ', el('code', {}, [m.tool_calls.map(t => t.function.name).join(', ')])]));
    const es = node.querySelector('.err-slot'); es.innerHTML = '';
    if (m.meta?.error) es.append(el('div', { class: 'error-box row gap wrap' }, [el('span', { style: 'flex:1' }, ['Error: ' + m.meta.error]), el('button', { class: 'btn sm', onclick: () => H.agent.regenerate() }, [H.icon('refresh'), 'Retry'])]));
    if (m.meta?.aborted) es.append(el('div', { class: 'muted small' }, ['(stopped)']));
    if (m.meta?.truncated && !m.meta.streaming) es.append(el('div', { class: 'row gap wrap truncated-box' }, [el('span', { class: 'muted small', style: 'flex:1' }, ['The reply was cut off at the output limit.']), el('button', { class: 'btn sm primary', onclick: () => H.agent.continueRun() }, ['Continue'])]));
    const turn = turnOf.get(node); if (turn) updateTurnStats(turn);
    const ps = node.querySelector('.plan-slot'); ps.innerHTML = '';
    if (m.meta?.plan && !m.meta.streaming) {
      const isLast = H.agent.current()?.messages.at(-1) === m;
      ps.append(el('div', { class: 'plan-bar' + (isLast ? '' : ' stale') }, [
        el('div', { class: 'plan-title' }, [H.icon('bolt'), el('b', {}, ['Plan ready']), el('span', { class: 'muted small' }, [isLast ? 'Review it, then execute or refine it in the chat.' : 'Superseded by later messages.'])]),
        el('span', { class: 'spacer' }),
        el('button', { class: 'btn sm', disabled: !isLast, onclick: () => { H.settings.set({ chatMode: 'default' }); H.agent.executePlan('default'); } }, ['Execute (ask for writes)']),
        el('button', { class: 'btn sm primary', disabled: !isLast, onclick: () => { H.settings.set({ chatMode: 'default' }); H.agent.executePlan('auto'); } }, [H.icon('send'), 'Execute (allow all)']),
      ]));
    }
  }
  function questionCard(m) {
    const q = m.meta.question; const chatId = H.agent.current()?.id;
    if (q.answered !== undefined) return el('div', { class: 'ask-card answered' }, [el('div', { class: 'ask-q' }, [H.icon('bolt'), q.text]), el('div', { class: 'ask-a' }, [q.answered?.cancelled ? 'No answer (skipped)' : 'Answer: ' + (q.answered?.answer ?? '') + (q.answered?.files?.length ? ` · attached: ${q.answered.files.join(', ')}` : '')])]);
    const input = el('textarea', { rows: 2, placeholder: 'Type your answer here or in the message box below…' });
    const send = () => { if (input.value.trim()) H.agent.answerQuestion(chatId, input.value.trim()); };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
    return el('div', { class: 'ask-card' }, [
      el('div', { class: 'ask-q' }, [H.icon('bolt'), el('b', {}, ['The assistant asks: ']), q.text]),
      q.choices.length ? el('div', { class: 'row gap wrap', style: 'margin:8px 0' }, q.choices.map(c => el('button', { class: 'btn sm', onclick: () => H.agent.answerQuestion(chatId, c) }, [c]))) : null,
      input,
      el('div', { class: 'row gap', style: 'margin-top:6px' }, [el('button', { class: 'btn sm primary', onclick: send }, ['Answer']), el('button', { class: 'btn sm ghost', onclick: () => H.agent.answerQuestion(chatId, '(The user chose not to answer. Proceed with your best judgement or explain what you need.)') }, ['Skip'])]),
    ]);
  }
  /* Tool results that carry unified diffs (git_diff, git_show, workspace_changes…) are worth looking at,
     not reading as JSON. fs_edit gets the same treatment, reconstructed from its own arguments. */
  function patchesOf(m) {
    const out = [];
    const push = (path, patch) => { if (typeof patch === 'string' && patch.trim()) out.push({ path: path || '', patch }); };
    if (m.name === 'fs_edit' && m.meta?.args?.old_string && !m.meta?.error) {
      const a = m.meta.args;
      push(a.path, H.diff.unified(String(a.old_string), String(a.new_string ?? ''), { path: a.path || 'file', context: 1 }));
      return out.length ? out : null;
    }
    if (!m.content || m.content[0] !== '{') return null;
    let d; try { d = JSON.parse(m.content); } catch { return null; }
    if (d?.error) return null;
    for (const f of d.files || []) push(f.path, f.patch);
    for (const c of d.commits || []) for (const f of c.changes || []) push(f.path, f.patch);
    if (!out.length) push(d.path, d.patch);
    return out.length ? out : null;
  }
  const MAX_DIFF_LINES = 400;
  function renderPatch({ path, patch }) {
    const lines = patch.split('\n');
    const shown = lines.slice(0, MAX_DIFF_LINES);
    const pre = el('pre', { class: 'diff' });
    for (const line of shown) {
      const c = line[0];
      const cls = line.startsWith('---') || line.startsWith('+++') ? 'dh' : line.startsWith('@@') ? 'dk' : c === '+' ? 'da' : c === '-' ? 'dr' : c === '\\' ? 'dh' : '';
      pre.append(el('span', { class: 'dl' + (cls ? ' ' + cls : '') }, [line === '' ? '\n' : line + '\n']));
    }
    if (lines.length > shown.length) pre.append(el('span', { class: 'dl dh' }, [`… ${lines.length - shown.length} more lines\n`]));
    return el('div', { class: 'diff-wrap' }, [path ? el('div', { class: 'diff-path' }, [path]) : null, pre]);
  }
  function updateTool(node, m) {
    const bodyKey = (m.meta?.running ? 'r' : 'd') + '|' + (m.meta?.error || '') + '|' + (m.content?.length || 0) + '|' + (m.meta?.question ? JSON.stringify(m.meta.question.answered ?? null) : '');
    const bodyChanged = node._bodyKey !== bodyKey; node._bodyKey = bodyKey;
    if (m.meta?.question) {   // ask_user: the card IS the question
      node.classList.add('ask'); node.open = true;
      const st = node.querySelector('.tstate'); st.textContent = m.meta.question.answered === undefined ? 'waiting for you' : 'answered';
      node.classList.toggle('running', m.meta.question.answered === undefined); node.classList.toggle('ok', m.meta.question.answered !== undefined);
      node.querySelector('.targs').textContent = m.meta.question.text;
      if (bodyChanged) { const body = node.querySelector('.tbody'); body.innerHTML = ''; body.append(questionCard(m)); }
      return;
    }
    const st = node.querySelector('.tstate'); const args = node.querySelector('.targs');
    const a = m.meta?.args; args.textContent = typeof a === 'object' ? JSON.stringify(a) : String(a || '');
    node.classList.remove('running', 'ok', 'error', 'denied');
    if (m.meta?.running) { node.classList.add('running'); st.innerHTML = ''; st.append(el('span', { class: 'spinner' })); if (m.meta.status) st.append(' ' + m.meta.status); }
    else if (m.meta?.denied) { node.classList.add('denied'); st.textContent = 'denied'; }
    else if (m.meta?.error) { node.classList.add('error'); st.textContent = 'error'; }
    else { node.classList.add('ok'); st.textContent = m.meta?.ms != null ? m.meta.ms + ' ms' : 'done'; }
    if (!bodyChanged) return;   // status ticks while running only touch the summary line above
    const ta = node.querySelector('.tactions'); ta.innerHTML = '';
    const tool = H.tools.get(m.name);
    if (tool?.rerun && !m.meta?.running && typeof a === 'object') {
      ta.append(el('button', { class: 'btn sm ghost rerun', title: 'Run this tool again with the same arguments (result is shown to you only, not sent to the model)', onclick: (e) => { e.preventDefault(); e.stopPropagation(); rerunTool(node, tool, a); } }, [H.icon('refresh'), tool.rerun]));
    }
    const body = node.querySelector('.tbody'); body.innerHTML = '';
    body.append(el('div', { class: 'lbl' }, ['Arguments']), el('pre', {}, [typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a || '')]));
    if (!m.meta?.running) {
      const patches = patchesOf(m);
      if (patches) {
        body.append(el('div', { class: 'lbl' }, ['Changes', el('span', { class: 'lbl-extra' }, [patches.length + (patches.length === 1 ? ' file' : ' files')])]));
        for (const p of patches) body.append(renderPatch(p));
      }
      let out = m.content; try { out = JSON.stringify(JSON.parse(out), null, 2); } catch { }
      body.append(el('div', { class: 'lbl' }, ['Result', el('span', { class: 'lbl-extra' }, [H.fmtBytes(m.content.length)])]), el('pre', {}, [H.clamp(out, patches ? 4000 : 20000)]));
    }
    body.append(el('div', { class: 'rerun-slot' }));
  }
  async function rerunTool(node, tool, args) {
    const needConfirm = typeof tool.rerunConfirm === 'function' ? tool.rerunConfirm(args) : !!tool.rerunConfirm;
    if (needConfirm && !confirm(`Run ${tool.name} again? This repeats an action that changes state.`)) return;
    const slot = node.querySelector('.rerun-slot'); slot.innerHTML = ''; node.open = true;
    slot.append(el('div', { class: 'lbl' }, ['Re-run', el('span', { class: 'lbl-extra' }, [el('span', { class: 'spinner' })])]));
    const perm = await H.perms.check(tool, args, {});
    let out;
    if (!perm.ok) out = { error: 'Permission denied: ' + perm.reason };
    else { try { out = await tool.run(args, { onStatus: () => { } }); } catch (e) { out = { error: e.message }; } }
    slot.innerHTML = '';
    slot.append(el('div', { class: 'lbl' }, ['Re-run result', el('span', { class: 'lbl-extra' }, [H.fmtClock(Date.now()) + ' · not sent to the model'])]), el('pre', {}, [H.clamp(typeof out === 'string' ? out : JSON.stringify(out, null, 2), 20000)]));
  }
  function onMessageAdded(m, chatId) {
    if (chatId && chatId !== H.agent.current()?.id) { renderChatList(); return; }   // belongs to a chat running in the background
    const wrap = $('#messages .msg-wrap'); const empty = $('#empty'); if (empty) empty.remove();
    for (const [msg, node] of nodeFor) if (msg.role === 'assistant' && msg.meta?.plan) updateAssistant(node, msg);   // earlier plan bars go stale
    placeMessage(wrap, m, H.agent.current()?.messages.indexOf(m) ?? 0); scrollBottom(); updateContextMeter();
  }
  /* streaming deltas arrive many times per second: coalesce them into one render per animation frame */
  const dirty = new Set(); let raf = 0;
  function flushUpdates() {
    raf = 0;
    for (const m of dirty) { const node = nodeFor.get(m); if (!node) continue; if (m.role === 'assistant') updateAssistant(node, m); else if (m.role === 'tool') updateTool(node, m); }
    dirty.clear(); scrollBottom();
  }
  function onMessageUpdated(m, chatId) {
    if (chatId && chatId !== H.agent.current()?.id) return;
    if (!nodeFor.has(m)) return;
    dirty.add(m);
    if (!m.meta?.streaming) { if (raf) cancelAnimationFrame(raf); flushUpdates(); updateContextMeter(); return; }   // final state: render now
    if (!raf) raf = requestAnimationFrame(flushUpdates);
  }
  let stick = true;
  function scrollBottom(force) { const b = $('#messages'); if (force || stick) b.scrollTop = b.scrollHeight; updateScrollBtn(); }
  function updateScrollBtn() { const b = $('#messages'); const far = b.scrollHeight - b.scrollTop - b.clientHeight > 200; $('#scroll-bottom').classList.toggle('hidden', !far); }

  /* ---------------- context / cost meter ---------------- */
  function updateContextMeter() {
    const chat = H.agent.current();
    const b = H.usage.contextBreakdown(chat); const pct = b.pct;
    const bar = $('#ctx-meter'); const circ = 2 * Math.PI * 15.5;
    bar.querySelector('.fg').style.strokeDasharray = `${circ * pct / 100} ${circ}`;
    bar.classList.toggle('warn', pct >= 70); bar.classList.toggle('danger', pct >= 90);
    bar.querySelector('.txt').textContent = `${pct}%` + (pct >= 90 ? ' context full' : pct >= 70 ? ' context' : '');
    const u = chat?.usage || { prompt: 0, completion: 0 };
    const cc = H.usage.chatCost(chat);
    const costTxt = H.settings.get('showCost') ? ' · ' + (cc.known ? H.usage.fmtCost(cc.cost) : 'set pricing') : '';
    $('#usage').textContent = `${H.usage.fmtTok((u.prompt || 0) + (u.completion || 0))} tok${costTxt}`;
    ctxPop?.repaint();
  }

  /* ---------------- context popup ----------------
     What the ring means, in one small panel: how the window is filled (what is always sent vs. the
     conversation vs. what is left), what the chat has cost so far, and the two things worth doing about
     it — compact now, or open the full usage page. Same floating-panel mechanics as picker(): a fixed
     .menu.float on <body>, placed against its trigger and registered in openMenus, so one outside click
     or Escape closes it and no two floating things are open at once. */
  let ctxPop = null;
  function openCtxPopup(trigger) {
    closeMenus();
    const body = el('div', { class: 'ctx-body' });
    const box = el('div', { class: 'ctx-pop', role: 'dialog', tabindex: '-1', 'aria-label': 'Context and cost for this chat', onclick: (e) => e.stopPropagation() }, [body]);
    const place = () => {
      const r = trigger.getBoundingClientRect();
      if (window.matchMedia('(max-width: 560px)').matches) { box.style.left = '8px'; box.style.right = '8px'; box.style.width = 'auto'; }
      else { box.style.right = 'auto'; box.style.width = ''; box.style.left = Math.round(Math.min(Math.max(8, r.right - box.offsetWidth), Math.max(8, window.innerWidth - box.offsetWidth - 8))) + 'px'; }
      const h = box.offsetHeight;
      const up = r.top > h + 8 || r.bottom + h + 8 > window.innerHeight;   // the composer sits at the bottom: hang it above
      box.style.top = Math.round(Math.min(Math.max(8, up ? r.top - 8 - h : r.bottom + 8), Math.max(8, window.innerHeight - h - 8))) + 'px';
    };
    const close = () => {
      if (!ctxPop) return;
      box.remove(); ctxPop = null;
      trigger.setAttribute('aria-expanded', 'false');
      removeEventListener('scroll', place, true); removeEventListener('resize', place);
      openMenus.delete(handle);
    };
    const repaint = () => { const h = box.offsetHeight; paintCtxPopup(body, close); if (box.offsetHeight !== h) place(); };
    const handle = { close };
    ctxPop = { close, repaint, trigger };
    paintCtxPopup(body, close);
    box.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); trigger.focus(); } });
    document.body.append(box); place(); box.focus();
    addEventListener('scroll', place, true); addEventListener('resize', place);
    trigger.setAttribute('aria-expanded', 'true');
    openMenus.add(handle);
  }
  function toggleCtxPopup(trigger) {
    if (ctxPop) { const same = ctxPop.trigger === trigger; ctxPop.close(); if (same) return; }
    openCtxPopup(trigger);
  }
  function paintCtxPopup(body, close) {
    const chat = H.agent.current();
    const b = H.usage.contextBreakdown(chat);
    const t = H.usage.chatTokens(chat); const cc = H.usage.chatCost(chat);
    const pct = b.pct; const level = pct >= 90 ? 'danger' : pct >= 70 ? 'warn' : '';
    const sent = t.requests > 0 || (chat?.messages || []).length > 0;
    const seg = (cls, tok) => el('div', { class: 'ctx-seg ' + cls, style: `width:${Math.max(0, tok / b.ctx * 100)}%` });
    const legend = (cls, label, tok, sub) => el('div', { class: 'ctx-leg' }, [
      el('span', { class: 'sw ' + cls }), el('span', { class: 'nm' }, [label]),
      el('span', { class: 'v' }, [H.usage.fmtTok(tok)]), sub ? el('span', { class: 'sub' }, [sub]) : null,
    ]);
    const kv = (k, v, cls) => el('div', { class: 'ctx-kv' }, [el('span', {}, [k]), el('b', { class: cls || null }, [].concat(v))]);

    body.className = 'ctx-body' + (level ? ' ' + level : '');
    body.innerHTML = '';
    body.append(
      el('div', { class: 'ctx-head' }, [el('span', { class: 'mono nm' }, [b.model || 'No model']), el('span', { class: 'muted' }, [`${H.usage.fmtTok(b.ctx)} window`])]),
      el('div', { class: 'ctx-pct' }, [el('b', {}, [pct + '%']), el('span', {}, ['of the context window in use'])]),
      el('div', { class: 'ctx-bar' }, [seg('fixed', b.fixed), seg('conv', b.conversation)]),
      el('div', { class: 'ctx-legs' }, [
        legend('fixed', 'System prompt + tools', b.fixed),
        legend('conv', 'Conversation', b.conversation, b.anchored ? null : 'estimated'),
        legend('free', 'Free', b.free),
      ]),
    );
    if (pct >= 70) body.append(el('p', { class: 'ctx-note' }, [
      H.settings.get('autoCompact')
        ? 'The older part will be summarised automatically before your next message, so the chat can keep going.'
        : 'Auto-compaction is off, so the chat will stop once the window is full. Type /compact to summarise the earlier part yourself.',
    ]));

    body.append(el('div', { class: 'ctx-kvs' }, [
      kv('Input', H.usage.fmtTok(t.prompt) + (t.cached ? ` (${H.usage.fmtTok(t.cached)} cached)` : '')),
      kv('Output', H.usage.fmtTok(t.completion)),
      kv('Requests', String(t.requests)),
      H.settings.get('showCost')
        ? kv('Cost', cc.known ? H.usage.fmtCost(cc.cost) + (cc.partial ? ' +' : '') : el('a', { href: '#', onclick: (e) => { e.preventDefault(); close(); openSettings('usage'); } }, ['set pricing']))
        : null,
    ]));
    if (!sent) body.append(el('p', { class: 'ctx-note muted' }, ['Nothing sent yet — the window holds the system prompt and the tool definitions.']));

    /* the way out of this chat's numbers and into every chat's: a quiet full-width row, not a stray button */
    body.append(el('button', { class: 'ctx-foot', onclick: () => { close(); openSettings('usage'); } }, [
      H.icon('chart'), el('span', { class: 'nm' }, ['Usage & costs across all chats']), H.icon('chev', 'ico go'),
    ]));
  }

  /* ---------------- sidebar ---------------- */
  /* the sidebar works from a small index (id, title, dates, counts, searchable text), rebuilt from storage only when needed */
  let chatIndex = null; let indexVersion = 1; let indexLoaded = 0; let listTimer = 0;
  const indexEntry = (c) => c.messages ? H.db.summary(c) : c;   // live chats are summarised here; listChats() already returns index records
  // one changed chat updates only its own entry; a full reload from storage happens only for deletions or an unloaded index
  H.bus.on('chat-updated', (c) => {
    if (chatIndex && indexLoaded === indexVersion && c && c.id) { const i = chatIndex.findIndex(x => x.id === c.id); const e = indexEntry(c); if (i >= 0) chatIndex[i] = e; else chatIndex.push(e); chatIndex.sort((a, b) => b.updated - a.updated); }
    else indexVersion++;
  });
  async function getIndex() {
    if (chatIndex && indexLoaded === indexVersion) return chatIndex;
    const v = indexVersion;
    const chats = await H.db.listChats();
    const idx = chats.map(indexEntry);
    if (v === indexVersion) { chatIndex = idx; indexLoaded = v; return idx; }   // a write happened meanwhile: reload
    return getIndex();
  }
  function renderChatList() { clearTimeout(listTimer); listTimer = setTimeout(renderChatListNow, 120); }   // coalesce bursts of events
  let listVersion = 0;
  async function renderChatListNow() {
    const v = ++listVersion;
    const chats = await getIndex(); const cur = H.agent.current();
    if (v !== listVersion) return;
    const list = $('#chat-list'); list.innerHTML = '';
    const q = ($('#chat-search')?.value || '').trim().toLowerCase();
    let bucket = null;
    const filtered = chats.filter(c => !q || c.text.includes(q));
    if (!filtered.length) list.append(el('div', { class: 'side-empty' }, [q ? 'No matching chats' : 'No chats yet']));
    for (const c of filtered) {
      const b = H.dateBucket(c.updated); if (b !== bucket) { bucket = b; list.append(el('div', { class: 'side-label' }, [b])); }
      const running = H.agent.isRunning(c.id);
      list.append(el('div', { class: 'chat-item' + (cur?.id === c.id ? ' active' : '') + (running ? ' running' : ''), onclick: () => H.agent.load(c.id), title: `${c.title}\n${c.count} messages · ${H.relTime(c.updated)}${running ? '\nRunning…' : ''}` }, [
        running ? el('span', { class: 'spinner' }) : null,
        el('span', { class: 'title' + (c.count ? '' : ' muted') }, [c.count || c.title !== 'New chat' ? c.title : 'New chat (empty)']),
        el('button', { class: 'btn sm icon del', title: 'Rename', onclick: async (e) => { e.stopPropagation(); const t = prompt('Chat title', c.title); if (t) { if (cur?.id === c.id) { await H.agent.rename(t); } else { const full = await H.db.getChat(c.id); if (full) { full.title = t; await H.db.putChat(full); } } indexVersion++; renderChatList(); } } }, [H.icon('edit')]),
        el('button', { class: 'btn sm icon del', title: 'Delete', onclick: (e) => { e.stopPropagation(); if (confirm('Delete chat "' + c.title + '"?')) H.agent.remove(c.id); } }, [H.icon('x')]),
      ]));
    }
  }

  /* ---------------- composer ---------------- */
  function autoresize() { const t = $('#input'); t.style.height = 'auto'; t.style.height = Math.min(260, t.scrollHeight) + 'px'; }
  async function submit() {
    const t = $('#input'); const text = t.value.trim();
    if (!text && !attachments.length) return;
    /* a system command runs here and now — before every guard below, so /copy works mid-run too — and never becomes a message */
    if (H.commands.run(text)) { t.value = ''; autoresize(); hideSlash(); return; }
    if (H.agent.pendingQuestion()) { H.agent.answerQuestion(H.agent.current().id, text); t.value = ''; autoresize(); return; }   // answer, not a new message
    if (H.agent.isRunning()) return;
    if (!H.settings.apiKey() && !confirm('No API key configured. Send anyway?')) { openSettings('general'); return; }
    const att = attachments; attachments = []; renderAttachments();
    t.value = ''; autoresize(); hideSlash(); drafts.delete(H.agent.current()?.id);
    await H.agent.send(text, att);
  }
  function renderAttachments() {
    const box = $('#attach-list'); box.innerHTML = '';
    attachments.forEach((a, i) => box.append(el('span', { class: 'chip' }, [H.icon('clip'), `${a.name} `, el('a', { href: '#', onclick: (e) => { e.preventDefault(); attachments.splice(i, 1); renderAttachments(); } }, ['✕'])])));
  }
  async function addFiles(files) {
    for (const f of files) {
      const status = H.toast(`Reading ${f.name}…`, 'info', 60000);
      const r = await H.extract.fromFile(f, { onStatus: (s) => { status.textContent = `${f.name}: ${s}`; }, maxChars: 200000 });
      status.remove();
      if (r.kind === 'image') { attachments.push({ name: f.name, size: f.size, kind: 'image', content: r.content }); if (r.note) H.toast(`${f.name}: ${r.note}`, 'info', 4000); }
      else if (r.kind === 'video') {
        for (const fr of r.frames) attachments.push({ name: fr.name, size: 0, kind: 'image', content: fr.content });
        attachments.push({ name: f.name, size: f.size, kind: 'text', content: r.transcript ? `Transcript:\n${r.transcript}` : '', note: r.note });
        H.toast(`${f.name}: ${r.note}`, 'info', 7000);
      }
      else if (r.kind === 'text') { attachments.push({ name: f.name, size: f.size, kind: 'text', content: r.content, pages: r.pages, note: r.note }); if (r.note) H.toast(`${f.name}: ${r.note}`, 'warn', 7000); }
      else { attachments.push({ name: f.name, size: f.size, kind: 'text', content: '', note: r.note }); H.toast(r.note, 'warn', 8000); }
    }
    renderAttachments();
  }
  /* The / menu holds both kinds of entry: system commands first (they run here, see js/commands.js), then skills.
     Once the box reads "/command " the same menu lists that command's options instead (/copy → all, code). */
  function slashItems() {
    const v = $('#input').value;
    const bare = v.match(/^\/([a-z0-9_-]*)$/i);
    if (bare) { const q = bare[1].toLowerCase(); return [...H.commands.list(), ...H.skills.list()].filter(s => s.name.startsWith(q)); }
    const sub = v.match(/^\/([a-z0-9_-]+)\s+([a-z0-9_-]*)$/i);
    const cmd = sub && H.commands.get(sub[1].toLowerCase());
    if (!cmd?.args) return null;
    const q = sub[2].toLowerCase();
    return cmd.args.filter(a => a.name.startsWith(q)).map(a => ({ name: cmd.name + (a.name ? ' ' + a.name : ''), description: a.description, full: '/' + cmd.name + (a.name ? ' ' + a.name : '') }));
  }
  function showSlash() {
    const items = slashItems(); const menu = $('#slash-menu');
    if (!items || !items.length) { hideSlash(); return; }
    menu.classList.remove('hidden'); menu.innerHTML = '';
    if (slashIdx >= items.length || slashIdx < 0) slashIdx = 0;
    items.forEach((s, i) => menu.append(el('div', { class: 'item' + (i === slashIdx ? ' active' : ''), onmousedown: (e) => { e.preventDefault(); pickSlash(s); } }, [el('b', {}, ['/' + s.name + (s.hint ? ' ' + s.hint : '')]), el('span', { class: 'muted small' }, [s.description])])));
  }
  function hideSlash() { $('#slash-menu').classList.add('hidden'); slashIdx = -1; }
  /* an option row completes the whole line (Enter then sends it); a command or skill row leaves the cursor after it */
  function pickSlash(s) { $('#input').value = s.full || '/' + s.name + ' '; hideSlash(); $('#input').focus(); }

  /* ================= MENUS & PICKERS =================
     Every floating list in the app (the ⋯ menu, the workspace menu, every dropdown) registers itself here, so one
     outside click or one Escape closes whatever is open, and no two can be open at once. */
  const openMenus = new Set();
  const closeMenus = (keep) => { for (const m of [...openMenus]) if (m !== keep) m.close(); };
  /** wire a button to a menu element that lives next to it (the ⋯ and workspace menus) */
  function bindMenu(btn, box, onOpen) {
    const handle = { close() { box.classList.add('hidden'); btn.setAttribute('aria-expanded', 'false'); openMenus.delete(handle); } };
    btn.setAttribute('aria-haspopup', 'menu'); btn.setAttribute('aria-expanded', 'false');
    btn.onclick = (e) => {
      e.stopPropagation();
      if (openMenus.has(handle)) return handle.close();
      closeMenus(); onOpen?.();
      box.classList.remove('hidden'); btn.setAttribute('aria-expanded', 'true'); openMenus.add(handle);
    };
    return handle;
  }

  /* The one dropdown the app uses. A native <select> cannot carry the sub-line that says what a choice means (what a
     model costs, what a mode does, where a plugin's requests go) and paints its own arrow in its own colours, so the
     trigger is a button and the list is the same kind of floating panel as the workspace menu. The panel is placed on
     <body> and positioned against the trigger: inside the scrolling settings body an absolute one would be clipped.
     cfg: { options:[{value,label,short,sub,group,mono,subMono,title,cls}], value, onpick(value, option),
            variant:'pill'|'field'|'mini', icon, title, placeholder, search, searchPlaceholder, empty, cls(option) } */
  function picker(cfg) {
    const variant = cfg.variant || 'field';
    const wrap = el('div', { class: 'menu-wrap' });
    const lbl = el('span', { class: 'lbl' });
    const btn = el('button', { type: 'button', 'aria-haspopup': 'listbox', 'aria-expanded': 'false' },
      [cfg.icon ? H.icon(cfg.icon) : null, lbl, H.icon('chev', 'ico chev')]);
    wrap.append(btn);
    let opts = cfg.options || [], cur = cfg.value, box = null, rows = [], idx = -1, filter = null, handle = null;
    const currentOpt = () => opts.find(o => o.value === cur) || null;

    function paint() {
      const o = currentOpt();
      lbl.textContent = o ? (o.short ?? o.label) : (cfg.placeholder ?? '—');
      lbl.classList.toggle('mono', !!(o && o.mono));
      btn.className = (variant === 'pill' ? 'pill-btn pick' : 'pick pick-' + variant) + (cfg.cls ? ' ' + (cfg.cls(o) || '') : '');
      const t = [cfg.title, o?.title || o?.sub].filter(Boolean).join(' · ');
      if (t) { btn.title = t; btn.setAttribute('aria-label', (cfg.title || '') + ': ' + (o ? o.label : 'none')); } else btn.removeAttribute('title');
    }
    function setCur(i) {
      if (!rows.length) { idx = -1; return; }
      idx = (i + rows.length) % rows.length;
      rows.forEach((r, n) => r.classList.toggle('cur', n === idx));
      rows[idx].scrollIntoView({ block: 'nearest' });
      (filter || box).setAttribute('aria-activedescendant', rows[idx].id);
    }
    function pick(o) { cur = o.value; paint(); close(); btn.focus(); cfg.onpick?.(o.value, o); }
    function build(q) {
      const list = box.querySelector('.pick-list'); list.innerHTML = ''; rows = [];
      let group = null;
      for (const o of opts) {
        if (q && !(o.label + ' ' + (o.sub || '') + ' ' + (o.group || '')).toLowerCase().includes(q)) continue;
        if (o.group && o.group !== group) { group = o.group; list.append(el('div', { class: 'menu-sec' }, [o.group])); }
        const row = el('button', {
          type: 'button', role: 'option', tabindex: '-1', id: 'opt-' + H.uid().slice(0, 8), title: o.title || null,
          class: 'opt' + (o.value === cur ? ' on' : '') + (o.rowCls ? ' ' + o.rowCls : ''), 'aria-selected': o.value === cur ? 'true' : 'false',
          onclick: (e) => { e.stopPropagation(); pick(o); },
          onmousemove: () => { const n = rows.indexOf(row); if (n !== idx) setCur(n); },
        }, [el('span', { class: 'nm' + (o.mono ? ' mono' : '') }, [o.label]), o.sub ? el('span', { class: 'sub' + (o.subMono ? ' mono' : '') }, [o.sub]) : null]);
        list.append(row); rows.push(row);
      }
      if (!rows.length) list.append(el('div', { class: 'menu-empty' }, [cfg.empty || 'Nothing matches']));
      setCur(Math.max(0, rows.findIndex(r => r.classList.contains('on'))));
    }
    function place() {
      const r = btn.getBoundingClientRect();
      const narrow = window.matchMedia('(max-width: 560px)').matches;
      box.style.width = narrow ? 'auto' : (variant === 'field' ? Math.max(r.width, 240) + 'px' : '');
      const h = box.offsetHeight;
      const up = r.bottom + h + 8 > window.innerHeight && r.top > h + 8;   // no room below: hang it above the trigger
      const top = Math.min(Math.max(8, up ? r.top - 6 - h : r.bottom + 6), Math.max(8, window.innerHeight - h - 8));
      box.style.top = Math.round(top) + 'px'; box.style.bottom = 'auto';
      if (narrow) { box.style.left = '8px'; box.style.right = '8px'; return; }
      box.style.right = 'auto';
      box.style.left = Math.round(Math.min(Math.max(8, r.left), Math.max(8, window.innerWidth - box.offsetWidth - 8))) + 'px';
    }
    function close() {
      if (!box) return;
      box.remove(); box = null; rows = []; filter = null; idx = -1;
      btn.setAttribute('aria-expanded', 'false');
      removeEventListener('scroll', place, true); removeEventListener('resize', place);
      openMenus.delete(handle); handle = null;
    }
    function open() {
      closeMenus();
      box = el('div', { class: 'menu float pick-menu' + (cfg.wide === false ? '' : ' wide'), role: 'listbox', tabindex: '-1', 'aria-label': cfg.title || cfg.placeholder || 'Options', onclick: (e) => e.stopPropagation() });
      if (cfg.search === true || (cfg.search !== false && opts.length > 8)) {
        filter = el('input', { type: 'text', placeholder: cfg.searchPlaceholder || 'Filter…', 'aria-label': cfg.searchPlaceholder || 'Filter', oninput: () => { build(filter.value.trim().toLowerCase()); place(); } });
        box.append(el('div', { class: 'menu-filter' }, [filter]));
      }
      box.append(el('div', { class: 'pick-list' }));
      box.addEventListener('keydown', onKey);
      document.body.append(box); build(''); place();
      btn.setAttribute('aria-expanded', 'true');
      (filter || box).focus();
      addEventListener('scroll', place, true); addEventListener('resize', place);
      handle = { close }; openMenus.add(handle);
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); btn.focus(); return; }
      if (e.key === 'Tab') { close(); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); setCur(idx + 1); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setCur(idx - 1); return; }
      if (e.key === 'Home') { e.preventDefault(); setCur(0); return; }
      if (e.key === 'End') { e.preventDefault(); setCur(rows.length - 1); return; }
      if (e.key === 'Enter' || (e.key === ' ' && !filter)) { e.preventDefault(); rows[idx]?.click(); return; }
      if (!filter && e.key.length === 1) {   // no filter field: jump to the next row starting with that letter
        const c = e.key.toLowerCase();
        const from = idx + 1, n = rows.length;
        for (let i = 0; i < n; i++) { const r = rows[(from + i) % n]; if (r.textContent.trim().toLowerCase().startsWith(c)) { setCur((from + i) % n); break; } }
      }
    }
    btn.onclick = (e) => { e.stopPropagation(); box ? close() : open(); };
    btn.addEventListener('keydown', (e) => { if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !box) { e.preventDefault(); open(); } });
    paint();
    return {
      el: wrap, btn,
      get value() { return cur; },
      set(v) { cur = v; paint(); },
      setOptions(list, v) { opts = list; if (v !== undefined) cur = v; if (box) close(); paint(); },
      close,
    };
  }

  /* ---------------- topbar ---------------- */
  let modelPick = null, modePick = null;
  /** the model list as picker rows: name, plus what the proxy says it costs and how much it can hold */
  function modelOptions(models, cur) {
    const list = (models || []).slice();
    if (cur && !list.includes(cur)) list.unshift(cur);
    const known = new Set(models || []);
    return list.map(m => {
      const p = H.usage.priceFor(m);
      const bits = [];
      if (p.context) bits.push(H.usage.fmtTok(p.context) + ' context');
      if (p.inPerTok != null) bits.push('$' + (p.inPerTok * 1e6).toFixed(2) + ' / 1M in');
      if (p.outPerTok != null) bits.push('$' + (p.outPerTok * 1e6).toFixed(2) + ' / 1M out');
      if (!known.has(m) && known.size) bits.unshift('not in the proxy list');
      return { value: m, label: m, mono: true, sub: bits.join(' · ') || 'no pricing known' };
    });
  }
  function setModelOptions(models, cur) {
    modelPick?.setOptions(modelOptions(models, cur), cur);
  }
  async function refreshModels() {
    const cur = H.settings.get('model');
    setModelOptions(H.settings.get('models') || [], cur);
    try {
      const models = await H.llm.listModels();
      const patch = { models }; if (!cur && models.length) patch.model = models[0];
      H.settings.set(patch);
      setModelOptions(models, patch.model || cur);
      setStatus('online', `${models.length} models`);
      H.usage.refreshModelInfo().then(() => { updateContextMeter(); setModelOptions(H.settings.get('models') || [], H.settings.get('model')); });
      return models;
    } catch (e) { setStatus('error', 'LiteLLM unreachable'); console.warn(e); throw e; }
  }
  function setStatus(kind, text) { const s = $('#status'); s.className = kind; s.querySelector('.txt').textContent = text; }
  /* "folder · branch ●3" — the branch comes from .git/HEAD (one small read); the change count only
     appears once something has actually run git_status, it is never computed to paint a button. */
  function updateWorkspaceBtn(name) {
    const n = (name === undefined ? H.fs.name() : name) || '';
    const f = H.fs.folder();
    const btn = $('#ws-btn');
    btn.querySelector('.lbl').textContent = n || 'No folder';
    btn.classList.toggle('primary', !!n);
    const g = n ? H.git.state() : null;
    let tag = btn.querySelector('.ws-git');
    const where = n ? `This chat works in "${n}"` : 'This chat has no folder open, so the file tools have nothing to work with';
    if (g?.branch) {
      if (!tag) { tag = el('span', { class: 'ws-git' }); btn.append(tag); }
      const dirty = (g.dirty || 0) + (g.untracked || 0);
      tag.textContent = '· ' + g.branch + (dirty ? ' ●' + dirty : '');
      btn.title = `${where}, on git branch ${g.branch}` + (g.dirty != null ? `, with ${g.dirty} changed and ${g.untracked} untracked file(s) at the last git_status` : '') + '.\nClick to work in a different folder.';
    } else { tag?.remove(); btn.title = where + '.\nClick to open a folder, or switch to one you used before.'; }
    btn.classList.toggle('needs-grant', !!(f && !f.granted));
  }
  /* The folder button opens a menu, not the OS picker: switching to a project you have opened before should be one
     click, not a trip through the file dialog. */
  function renderWorkspaceMenu() {
    const box = $('#ws-menu'); box.innerHTML = '';
    const f = H.fs.folder();
    const git = H.git.state();
    box.append(el('div', { class: 'menu-sec' }, ['This chat works in']));
    if (f) {
      const bits = [];
      if (git?.branch) bits.push(git.branch);
      if (f.mode === 'read') bits.push('read-only');
      if (!f.granted) bits.push('needs access');
      const row = el('button', {
        class: 'opt on' + (f.granted ? '' : ' warn'),
        title: f.granted ? `File paths are relative to "${f.name}"` : 'Browsers only re-grant folder access from a click',
        onclick: async (e) => {
          e.stopPropagation();
          try { if (!f.granted && !await H.fs.grant()) H.toast(`Access to "${f.name}" was not granted.`, 'warn'); }
          catch (err) { H.toast(err.message, 'error', 6000); }
          renderWorkspaceMenu();
        },
      }, [el('span', { class: 'nm' }, [f.name]), bits.length ? el('span', { class: 'sub mono' }, [bits.join(' · ')]) : null]);
      row.append(el('span', { class: 'acts' }, [
        f.granted ? null : el('span', { class: 'act warn' }, ['Grant access']),
        el('span', {
          class: 'act', title: f.mode === 'read' ? 'Allow the assistant to write to this folder' : 'Let the assistant read this folder but not write to it',
          onclick: (e) => { e.stopPropagation(); H.fs.setMode(f.mode === 'read' ? 'readwrite' : 'read'); renderWorkspaceMenu(); },
        }, [f.mode === 'read' ? 'read-only' : 'writable']),
        el('span', { class: 'act', title: 'Close this folder: the file tools go idle until another is open', onclick: (e) => { e.stopPropagation(); H.fs.close(); renderWorkspaceMenu(); } }, ['close']),
      ]));
      box.append(row);
    } else {
      box.append(el('button', { class: 'opt', title: 'The file tools have nothing to work with until a folder is open', onclick: (e) => e.stopPropagation() },
        [el('span', { class: 'nm muted' }, ['No folder']), el('span', { class: 'sub' }, ['the file tools are idle'])]));
    }
    box.append(el('button', {
      title: f ? `Work in another folder instead of "${f.name}"` : 'Open a folder for this chat to work in',
      onclick: async (e) => {
        e.stopPropagation();
        try { const name = await H.fs.pick(); H.toast('Working in ' + name, 'success'); closeMenus(); }
        catch (err) { if (err.name !== 'AbortError') H.toast(err.message, 'error', 6000); }
      },
    }, [H.icon('folder'), f ? 'Work in another folder…' : 'Open folder…']));
    H.db.folders().then(rows => {
      const recent = rows.filter(r => r.handle && r.id !== f?.id).sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0)).slice(0, 6);
      if (!recent.length || box.classList.contains('hidden')) return;
      box.append(el('div', { class: 'menu-sec' }, ['Recent']));
      for (const r of recent) {
        box.append(el('button', {
          class: 'opt', title: 'Work in this folder again (the browser will ask for access)',
          onclick: async (e) => {
            e.stopPropagation();
            try { await H.fs.open(r.handle, { mode: r.mode || 'readwrite' }); if (!await H.fs.grant()) H.toast(`Access to "${r.name}" was not granted.`, 'warn'); closeMenus(); }
            catch (err) { H.toast(err.message, 'error', 6000); }
          },
        }, [el('span', { class: 'nm' }, [r.name]), el('span', { class: 'sub' }, [H.relTime(r.lastUsed || Date.now())])]));
      }
    }).catch(() => { });
  }
  /* Files this chat changed on disk, with the diff against what it found and a way to put it back. Git here is
     read-only, so this is the only undo there is — it restores from the copies H.journal kept before each write. */
  async function changesPanel() {
    const ov = el('div', { class: 'modal-overlay', onclick: (e) => { if (e.target === ov) ov.remove(); } });
    const body = el('div', { class: 'chg-body' }, [el('p', { class: 'muted' }, ['Loading…'])]);
    const head = el('div', { class: 'row gap' }, [el('h3', {}, ['Files changed in this chat']), el('span', { class: 'spacer' })]);
    ov.append(el('div', { class: 'modal wide' }, [head, body]));
    document.body.append(ov);
    const render = async () => {
      const rows = await H.journal.list();
      body.innerHTML = '';
      head.querySelectorAll('.chg-act').forEach(b => b.remove());
      if (!rows.length) {
        body.append(el('p', { class: 'muted' }, [H.journal.enabled()
          ? 'Nothing yet. Every file this chat writes, edits or deletes is recorded here with its previous contents, so you can put it back.'
          : 'File history is turned off in Settings → Workspace, so changes are not recorded.']));
        return;
      }
      const live = rows.filter(r => !r.unchanged && !r.elsewhere);
      head.append(el('button', { class: 'btn sm chg-act', title: 'Save every change in this chat as a patch file', onclick: () => {
        H.download('chat-changes.patch', rows.map(r => r.patch).filter(Boolean).join('') || '(no textual changes)', 'text/x-patch');
      } }, ['Export as .patch']));
      if (live.length) head.append(el('button', { class: 'btn sm danger-outline chg-act', onclick: async () => {
        if (!confirm(`Restore ${live.length} file(s) to the state this chat found them in?`)) return;
        for (const r of live) { try { await H.journal.revert(r); } catch (e) { H.toast(e.message, 'error', 6000); } }
        H.toast('Reverted.', 'success'); render();
      } }, ['Revert all']));
      for (const r of rows) {
        const label = el('div', { class: 'chg-head' }, [
          el('span', { class: 'chg-status ' + r.status }, [r.unchanged ? 'unchanged' : r.status]),
          el('code', {}, [r.address]),
          el('span', { class: 'spacer' }),
          el('span', { class: 'small muted' }, [`${r.count} write${r.count > 1 ? 's' : ''} · ${H.relTime(r.last)}`]),
          r.unchanged || r.elsewhere ? null : el('button', {
            class: 'btn sm ghost', title: r.note ? 'The previous contents were not kept' : 'Put this file back the way the chat found it', disabled: !!r.note,
            onclick: async (e) => { e.stopPropagation(); try { await H.journal.revert(r); H.toast('Reverted ' + r.address, 'success'); render(); } catch (err) { H.toast(err.message, 'error', 6000); } },
          }, ['Revert']),
        ]);
        const det = el('details', { class: 'chg-row' }, [el('summary', {}, [label])]);
        if (r.patch) det.append(renderPatch({ path: r.address, patch: r.patch }));
        else det.append(el('p', { class: 'small muted', style: 'padding:6px 10px' }, [
          r.elsewhere ? `Changed while this chat was working in "${r.elsewhere}". Open that folder again to see the diff or put it back.`
            : r.note ? `No diff: ${r.note}.` : 'No textual change.']));
        body.append(det);
      }
    };
    await render();
  }
  /* the three chat modes, named once: the pill under the message box and the cards in Settings say the same thing */
  const MODES = [
    { v: 'default', t: 'Default', short: 'reads freely, asks before it writes', d: 'Safe, read-only tools run automatically. Anything that writes, executes or sends data asks you first.' },
    { v: 'auto', t: 'Allow all', short: 'every tool runs without asking', d: 'Every tool runs without asking (except tools you explicitly denied). Fastest, least safe.' },
    { v: 'plan', t: 'Plan', short: 'investigate only, then a plan to execute', d: 'The model can only read and investigate. It produces a numbered plan; you then choose to execute it with the permissions you want.' },
  ];
  function updateModeUI() {
    const mode = H.perms.effectiveMode();
    modePick?.set(H.settings.get('chatMode'));
    document.body.dataset.mode = mode;
    if (H.agent.pendingQuestion()) { $('#input').placeholder = 'Answer the assistant\'s question…'; $('#send-btn').classList.remove('hidden'); $('#stop-btn').classList.add('hidden'); document.body.classList.add('asking'); return; }
    document.body.classList.remove('asking');
    if (modePick) modePick.btn.title = 'Chat mode · ' + (MODES.find(m => m.v === mode)?.short || mode);
    $('#input').placeholder = mode === 'plan' ? 'Plan mode: describe what you want planned…' : window.matchMedia('(max-width: 560px)').matches ? 'Message…' : 'Message… type / for commands and skills, drop files to attach';
  }
  function updateTitle() { const c = H.agent.current(); $('#chat-title').textContent = c?.title || 'New chat'; }
  function bugReport() {
    const s = H.settings.get(); const c = H.agent.current();
    const body = `**What happened**\n\n\n**What I expected**\n\n\n**Steps to reproduce**\n1.\n\n---\nVersion: ${H.ABOUT.version} · Browser: ${navigator.userAgent} · Origin: ${/^https?:/.test(location.origin) ? location.origin : 'file://'} · Mode: ${s.chatMode} · Model: ${s.model || '-'} · Plugins enabled: ${H.plugins.list().filter(p => p.enabled).map(p => p.id).join(', ') || 'none'} · Bridges: ${H.bridge.list().length}${c?.messages.length ? ` · Last tool error: ${(c.messages.filter(m => m.role === 'tool' && m.meta?.error).at(-1)?.meta.error || '-').slice(0, 200)}` : ''}`;
    window.open(`${H.ABOUT.repoUrl}/issues/new?title=${encodeURIComponent('Bug: ')}&body=${encodeURIComponent(body)}`, '_blank', 'noopener');
  }

  /* ================= SETTINGS =================
     Ten sections, each with one job. Every control carries its settings key as id="set-<key>", so anything that
     needs to point at one setting — a deep link, a future jump-to — has a stable handle for it. */
  let settingsModal = null;
  const SECTIONS = [
    ['general', 'General', 'link'], ['model', 'Model', 'cube'], ['permissions', 'Permissions', 'shield'],
    ['workspace', 'Workspace', 'folder'], ['plugins', 'Plugins', 'plug'], ['skills', 'Skills', 'bolt'],
    ['web', 'Web access', 'globe'], ['usage', 'Usage & costs', 'chart'], ['privacy', 'Privacy & data', 'lock'], ['about', 'About', 'beer'],
  ];
  /* older section names still used by deep links elsewhere in the app */
  const SECTION_ALIAS = { connection: 'general', interface: 'general', modes: 'permissions', tools: 'permissions', security: 'privacy', data: 'privacy' };
  function openSettings(section = 'general') {
    if (settingsModal) settingsModal.remove();
    const nav = el('nav', { class: 'settings-nav' });
    const body = el('div', { class: 'settings-body' });
    const builders = { general: generalPanel, model: modelPanel, permissions: permissionsPanel, workspace: workspacePanel, plugins: pluginsPanel, skills: skillsPanel, web: webPanel, usage: usagePanel, privacy: privacyPanel, about: aboutPanel };
    let curSection = SECTION_ALIAS[section] || section;
    if (!builders[curSection]) curSection = 'general';

    const show = (k) => {
      curSection = k;
      nav.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.k === k));
      body.innerHTML = ''; body.append(builders[k]()); body.scrollTop = 0;
    };
    /* rebuild the current section in place: a setting that changes what its own panel shows must not throw the
       reader back to the top of the page (which re-opening the whole dialog used to do) */
    const repaint = () => { const y = body.scrollTop; body.innerHTML = ''; body.append(builders[curSection]()); body.scrollTop = y; };
    settingsRepaint = repaint;

    for (const [k, label, ic] of SECTIONS) nav.append(el('button', { 'data-k': k, onclick: () => show(k) }, [H.icon(ic), el('span', {}, [label])]));

    settingsModal = el('div', { class: 'modal-overlay', onclick: (e) => { if (e.target === settingsModal) close(); } }, [el('div', { class: 'modal settings' }, [
      el('div', { class: 'modal-head' }, [el('h3', {}, ['Settings']), el('span', { class: 'spacer' }), el('button', { class: 'btn icon ghost', title: 'Close', onclick: close }, [H.icon('x')])]),
      el('div', { class: 'settings-layout' }, [nav, body])])]);
    document.body.append(settingsModal); show(curSection);
    settingsClose = close;
    function close() { settingsModal.remove(); settingsModal = null; settingsRepaint = null; settingsClose = null; updateModeUI(); updateContextMeter(); }
  }
  /* set while the dialog is open, so a control can refresh its own panel without re-opening the dialog,
     or step out of the dialog entirely and hand the user back to the chat */
  let settingsRepaint = null, settingsClose = null;
  const sec = (title, desc, children) => el('section', { class: 'sec' }, [el('h4', {}, [title]), desc ? el('p', { class: 'sec-desc' }, [desc]) : null, ...[].concat(children)]);
  /* action = a button that belongs beside the input. It goes on the input's own line, not floated next to the
     whole field, so it lines up with the box rather than with the label above it. */
  const field = (label, key, type = 'text', extra = {}, action = null) => {
    const s = H.settings.get();
    const input = el('input', { type, value: s[key] ?? '', ...extra, onchange: (e) => H.settings.set({ [key]: type === 'number' ? +e.target.value : e.target.value }) });
    return el('label', { class: 'field', id: 'set-' + key }, [el('span', {}, [label]), action ? el('div', { class: 'input-row' }, [input, action]) : input]);
  };
  /* options: [value, label, sub?] — the sub-line says what the choice does, which an <option> could never hold */
  const selectField = (label, key, options, onchange) => {
    const s = H.settings.get();
    const p = picker({ value: s[key], title: label, options: options.map(([v, l, sub]) => ({ value: v, label: l, sub })), onpick: (v) => { H.settings.set({ [key]: v }); onchange && onchange(v); } });
    return el('div', { class: 'field', id: 'set-' + key }, [el('span', {}, [label]), p.el]);
  };

  /* ---------- settings controls ----------
     One shape per kind of value: a switch for on/off, a slider for a position on a range, a stepper for a
     counted amount, a revealable box for a secret. Each says what it does now, not only what it is called. */

  /** on/off, as a switch with the consequence spelled out. opts.state(v) -> the line under the label. */
  const toggle = (label, key, help, opts = {}) => {
    const get = opts.get || (() => !!H.settings.get(key));
    const line = el('span', { class: 'set-help' });
    const input = el('input', { type: 'checkbox', role: 'switch', checked: get(), onchange: (e) => { (opts.set || ((v) => H.settings.set({ [key]: v })))(e.target.checked); paint(); opts.onchange?.(e.target.checked); } });
    const paint = () => { line.textContent = (opts.state ? opts.state(input.checked) : help) || ''; line.classList.toggle('hidden', !line.textContent); };
    paint();
    return el('label', { class: 'set-row' + (opts.sub ? ' sub' : ''), id: 'set-' + key }, [
      el('span', { class: 'set-text' }, [el('span', { class: 'set-label' }, [label]), line]),
      el('span', { class: 'switch' }, [input, el('span', { class: 'track' }, [el('span', { class: 'knob' })])]),
    ]);
  };
  /** a position on a range, with the live value next to the label and a word at each end
      opts: { min, max, step, ends:[left,right], format(v), toStored(v), fromStored(v), onchange(v) } */
  const slider = (label, key, opts = {}) => {
    const from = opts.fromStored || ((v) => v), to = opts.toStored || ((v) => v);
    const fmt = opts.format || ((v) => String(v));
    const val = el('b', { class: 'set-value' });
    const input = el('input', {
      type: 'range', min: opts.min, max: opts.max, step: opts.step ?? 1, value: from(H.settings.get(key) ?? opts.min),
      oninput: () => { val.textContent = fmt(+input.value); },
      onchange: () => { H.settings.set({ [key]: to(+input.value) }); opts.onchange?.(to(+input.value)); },
    });
    val.textContent = fmt(+input.value);
    return el('div', { class: 'field slider-field', id: 'set-' + key }, [
      el('span', {}, [label, val]), input,
      opts.ends ? el('span', { class: 'ends' }, [el('i', {}, [opts.ends[0]]), el('i', {}, [opts.ends[1]])]) : null,
    ]);
  };
  /** a counted amount: −/+ either side of the number, unit spelled out, clamped on the way in
      opts: { min, max, step, unit, help } */
  const stepper = (label, key, opts = {}) => {
    const min = opts.min ?? 0, max = opts.max ?? Infinity, step = opts.step || 1;
    const input = el('input', { type: 'number', value: H.settings.get(key) ?? min, min, max: max === Infinity ? null : max, step, onchange: () => commit(+input.value) });
    /* a typed number is kept as typed (only clamped); the −/+ buttons are what snap to the step, so someone who
       knows they want 8192 tokens does not get 8000 */
    const commit = (v, snap) => { v = isNaN(v) ? min : v; if (snap) v = Math.round(v / step) * step; v = Math.min(max, Math.max(min, v)); input.value = v; H.settings.set({ [key]: v }); opts.onchange?.(v); };
    const bump = (d) => commit((+input.value || 0) + d * step, true);
    return el('div', { class: 'field', id: 'set-' + key }, [
      el('span', {}, [label]),
      el('div', { class: 'stepper' }, [
        el('button', { class: 'btn icon ghost', type: 'button', title: 'Less', 'aria-label': 'Decrease ' + label, onclick: () => bump(-1) }, ['−']),
        input, opts.unit ? el('span', { class: 'unit' }, [opts.unit]) : null,
        el('button', { class: 'btn icon ghost', type: 'button', title: 'More', 'aria-label': 'Increase ' + label, onclick: () => bump(1) }, ['+']),
      ]),
      opts.help ? el('span', { class: 'help' }, [opts.help]) : null,
    ]);
  };
  /** a secret: hidden by default, revealable, and honest about where it is kept */
  const secretField = (label, get, set, anchorKey, placeholder = 'sk-…') => {
    const input = el('input', { type: 'password', value: get(), placeholder, autocomplete: 'off', spellcheck: 'false', onchange: (e) => { set(e.target.value.trim()); paintWhere(); } });
    const where = el('span', { class: 'help' });
    const paintWhere = () => { where.textContent = !input.value ? 'Not set.' : H.secrets.persist() ? 'Stored on this device. Privacy & data → Secrets keeps it for this session only instead.' : 'Kept for this browser session only (Privacy & data → Secrets).'; };
    paintWhere();
    const eye = el('button', { class: 'btn ghost', type: 'button', onclick: () => { const on = input.type === 'password'; input.type = on ? 'text' : 'password'; eye.textContent = on ? 'Hide' : 'Show'; } }, ['Show']);
    return el('div', { class: 'field', id: 'set-' + anchorKey }, [
      el('span', {}, [label]),
      el('div', { class: 'input-row secret-field' }, [input, eye, el('button', { class: 'btn ghost', type: 'button', title: 'Clear this value', onclick: () => { input.value = ''; set(''); paintWhere(); } }, ['Clear'])]),
      where,
    ]);
  };
  /** a URL that says so when it is not one yet — one help line, never a stack of them:
      a problem replaces the explanation, and is the only thing that ever turns the line amber */
  const urlField = (label, key, opts = {}) => {
    const out = el('span', { class: 'help' });
    const input = el('input', { type: 'text', value: H.settings.get(key) ?? '', placeholder: opts.placeholder || '', spellcheck: 'false', autocomplete: 'off', oninput: paint, onchange: (e) => { H.settings.set({ [key]: e.target.value.trim() }); opts.onchange?.(e.target.value.trim()); } });
    function paint() {
      const v = input.value.trim();
      const say = (txt, warn) => { out.textContent = txt || ''; out.className = 'help' + (warn ? ' warn-text' : ''); };
      if (!v) return say(opts.empty || opts.help);
      try { new URL(v.replace('{url}', 'x').replace('{q}', 'x')); say(opts.help); }
      catch { say('That is not a URL yet — it needs to start with https:// or http://', true); }
    }
    paint();
    return el('label', { class: 'field', id: opts.id === false ? null : 'set-' + key }, [el('span', {}, [label]), input, out]);
  };
  /** the knobs almost nobody touches, one click away instead of in the way. The contents go in their own box so
      the indent is the box's, not each child's — a list keeps the padding its bullets need. */
  const advanced = (children, label = 'Advanced') => {
    const k = 'harness.adv.' + label;
    return el('details', { class: 'adv', open: sessionStorage.getItem(k) === '1' || null, ontoggle: (e) => sessionStorage.setItem(k, e.target.open ? '1' : '0') },
      [el('summary', {}, [H.icon('chev'), label]), el('div', { class: 'adv-body' }, [].concat(children).filter(Boolean))]);
  };

  function generalPanel() {
    const status = el('span', { class: 'chip hidden' });
    const test = el('button', { class: 'btn primary', onclick: async () => {
      status.className = 'chip'; status.textContent = 'Connecting…'; test.disabled = true;
      try { const m = await refreshModels(); status.className = 'chip ok'; status.textContent = `Connected · ${m.length} models`; }
      catch (e) { status.className = 'chip danger'; status.textContent = 'Failed: ' + e.message; }
      finally { test.disabled = false; }
    } }, ['Test connection']);
    return el('div', {}, [
      sec('LiteLLM proxy', 'The app talks to your LiteLLM proxy directly from this browser tab. Nothing else sits in between.', [
        urlField('Base URL', 'baseUrl', { placeholder: 'https://litellm.example.com', help: 'The root of the proxy, without /v1. The proxy has to allow this page\'s origin (LiteLLM allows all origins by default).' }),
        secretField('API key', () => H.settings.apiKey(), (v) => H.settings.setApiKey(v), 'apiKey'),
        el('div', { class: 'row gap' }, [test, status]),
      ]),
      sec('Appearance & behaviour', null, [
        selectField('Theme', 'theme', [['system', 'Follow system', 'changes with your OS setting'], ['dark', 'Dark'], ['light', 'Light']], applyTheme),
        selectField('Send message with', 'sendKey', [['enter', 'Enter', 'Shift+Enter makes a new line'], ['ctrlenter', 'Ctrl / Cmd + Enter', 'Enter makes a new line']]),
        toggle('Stream responses', 'streaming', null, { state: (v) => v ? 'The reply appears as it is written.' : 'The reply appears all at once, when it is finished.' }),
        toggle('Auto-title new chats', 'autoTitle', null, { state: (v) => v ? 'A small extra request names each new chat after the first message.' : 'New chats keep the name "New chat" until you rename them.' }),
        toggle('Show cost', 'showCost', null, { state: (v) => v ? 'Money spent is shown under the message box and on each reply.' : 'Only token counts are shown; prices stay hidden.', onchange: () => updateContextMeter() }),
      ]),
    ]);
  }
  function modelPanel() {
    const s = H.settings.get();
    const pick = picker({
      value: s.model, title: 'Default model', options: modelOptions(s.models, s.model), search: true,
      searchPlaceholder: 'Filter models…', empty: 'No model matches', placeholder: 'No models loaded',
      onpick: (v) => { H.settings.set({ model: v }); modelPick?.set(v); info(); updateContextMeter(); },
    });
    const repaint = (models) => { const m = H.settings.get('model'); pick.setOptions(modelOptions(models ?? H.settings.get('models'), m), m); setModelOptions(models ?? H.settings.get('models'), m); info(); };
    const infoBox = el('div', { class: 'kv-card' });
    const info = () => { const m = H.settings.get('model'); const p = H.usage.priceFor(m); const mi = H.settings.get('modelInfo')?.[m]; infoBox.innerHTML = ''; infoBox.append(el('div', { class: 'kv' }, [
      el('span', {}, ['Context window']), el('b', {}, [p.context ? p.context.toLocaleString() + ' tokens' : 'unknown']),
      el('span', {}, ['Input price']), el('b', {}, [p.inPerTok != null ? '$' + (p.inPerTok * 1e6).toFixed(2) + ' / 1M' + (p.cachedPerTok != null ? ` (cached: $${(p.cachedPerTok * 1e6).toFixed(2)})` : '') : 'unknown']),
      el('span', {}, ['Output price']), el('b', {}, [p.outPerTok != null ? '$' + (p.outPerTok * 1e6).toFixed(2) + ' / 1M' : 'unknown']),
      el('span', {}, ['Source']), el('b', {}, [p.source === 'litellm' ? 'LiteLLM /model/info' : p.source === 'manual' ? 'manual override' : 'not available' + (mi?.provider ? ' · ' + mi.provider : '')]),
    ])); };
    info();
    const custom = el('input', { type: 'text', placeholder: 'e.g. my-private-deployment', onchange: (e) => { const v = e.target.value.trim(); if (v) { H.settings.set({ model: v }); repaint(); e.target.value = ''; } } });
    /* the compaction knobs only do anything while it is on, and say so by going quiet */
    const compactBox = el('div', { class: 'indent' });
    const paintCompact = () => compactBox.classList.toggle('off', !H.settings.get('autoCompact'));
    compactBox.append(
      slider('Compact when the chat reaches', 'compactAt', {
        min: 50, max: 95, step: 5, ends: ['sooner, cheaper', 'later, fuller'],
        fromStored: (v) => Math.round(v * 100), toStored: (v) => v / 100, format: (v) => v + '% of the window',
        onchange: () => updateContextMeter(),
      }),
      stepper('Turns kept word for word', 'compactKeepTurns', { min: 1, max: 20, unit: 'user turns', help: 'The most recent part of the chat is never summarised.' }),
    );
    paintCompact();
    return el('div', {}, [
      sec('Default model', 'The model new chats start with. The list comes from your LiteLLM proxy; the pill under the message box switches model for one chat.', [
        el('div', { class: 'row gap', id: 'set-model' }, [pick.el, el('button', { class: 'btn', onclick: async () => { try { const m = await refreshModels(); repaint(m); H.toast(`${m.length} models loaded`, 'success'); } catch (e) { H.toast(e.message, 'error'); } } }, [H.icon('refresh'), 'Refresh'])]),
        infoBox,
      ]),
      sec('Generation', null, [
        slider('Temperature', 'temperature', { min: 0, max: 2, step: 0.1, ends: ['precise, repeatable', 'varied, creative'], format: (v) => v.toFixed(1) }),
        stepper('Max output tokens', 'maxTokens', { min: 256, max: 200000, step: 1000, unit: 'tokens', help: 'The longest single reply. Too low and long answers get cut off mid-sentence.' }),
        stepper('Max tool calls per turn', 'maxToolIterations', { min: 1, max: 100, unit: 'calls', help: 'A stop so a confused model cannot loop forever. It is told when it runs out.' }),
        el('label', { class: 'field', id: 'set-systemPrompt' }, [el('span', {}, ['Custom system prompt']), el('textarea', { rows: 5, placeholder: 'Anything here is added in front of the built-in instructions — house style, your name, standing rules.', onchange: (e) => H.settings.set({ systemPrompt: e.target.value }) }, [s.systemPrompt])]),
      ]),
      sec('Long chats', 'A chat that fills the model\'s context window cannot continue. Compaction replaces the older part with a summary the model writes, so the chat keeps going and the cost stays flat.', [
        toggle('Compact automatically', 'autoCompact', null, { onchange: paintCompact, state: (v) => v ? 'Happens on its own once the chat gets big enough.' : 'Never happens on its own — run /compact in the message box when a chat gets long.' }),
        compactBox,
        advanced([
          el('p', { class: 'help' }, ['Separately from compaction, the app shortens old tool output: results from earlier turns are sent as a short stub the model can refresh by calling the tool again. This is what keeps a long file-reading session affordable.']),
          stepper('Full tool results for the last', 'keepToolTurns', { min: 0, max: 20, unit: 'user turns' }),
          stepper('Older tool results shortened to', 'toolStubChars', { min: 80, max: 4000, step: 40, unit: 'characters' }),
        ]),
      ]),
      sec('Media', 'Images are resized in this browser before they are sent. Video becomes a few sampled frames plus a transcript, audio becomes a transcript — both need a speech-to-text model on your proxy.', [
        field('Transcription model', 'transcriptionModel', 'text', { placeholder: 'whisper-1 — empty turns transcription off' },
          el('button', { class: 'btn', type: 'button', title: 'Look for a speech-to-text model in the proxy\'s list', onclick: () => { const w = (H.settings.get('models') || []).filter(m => /whisper|transcri|speech|stt/i.test(m)); H.toast(w.length ? 'Speech models on your proxy: ' + w.join(', ') : 'No obvious speech-to-text model in the model list; ask your LiteLLM admin.', w.length ? 'success' : 'warn', 8000); } }, ['Find'])),
        el('p', { class: 'help' }, ['Images and video frames also need a multimodal chat model; without one the proxy rejects the request and the error shows up in the chat.']),
      ]),
      advanced([
        el('label', { class: 'field' }, [el('span', {}, ['Use a model name that is not in the list']), custom, el('span', { class: 'help' }, ['For a deployment your proxy serves but does not advertise. It is used exactly as typed.'])]),
        stepper('Fallback context window', 'defaultContext', { min: 4000, max: 2000000, step: 1000, unit: 'tokens', help: 'Assumed for models whose real window the proxy does not report — it is what the ring under the message box fills up against.', onchange: () => updateContextMeter() }),
      ]),
    ]);
  }
  /* One page, read top to bottom: the mode sets the rule for everything, a per-tool override beats the mode,
     and a site answer beats both for the two tools that reach the open web. */
  function permissionsPanel() {
    const s = H.settings.get();
    const wrap = el('div', {});
    const cur = s.chatMode;
    const groups = H.tools.groups();
    const disabled = new Set(s.disabledTools || []);
    const total = Object.values(groups).flat().length;
    const filter = el('input', { type: 'text', placeholder: `Filter ${total} tools…`, oninput: () => { const q = filter.value.toLowerCase(); wrap.querySelectorAll('.tool-row').forEach(r => r.classList.toggle('hidden', !!q && !r.dataset.k.includes(q))); wrap.querySelectorAll('.group-title').forEach(g => { let n = g.nextElementSibling, any = false; while (n && n.classList.contains('tool-row')) { if (!n.classList.contains('hidden')) any = true; n = n.nextElementSibling; } g.classList.toggle('hidden', !any); }); } });
    const bulk = (fn) => { for (const t of Object.values(groups).flat()) fn(t); settingsRepaint?.(); };

    wrap.append(sec('Chat mode', 'What the assistant may do without asking. The same pill sits under the message box; a change applies to the next tool call straight away.', [
      el('div', { class: 'mode-cards', id: 'set-chatMode' }, MODES.map(({ v, t, d }) => el('label', { class: 'mode-card' + (cur === v ? ' active' : '') }, [el('input', { type: 'radio', name: 'mode', value: v, checked: cur === v, onchange: () => { H.settings.set({ chatMode: v }); updateModeUI(); settingsRepaint?.(); } }), el('b', {}, [t]), el('span', { class: 'small muted' }, [d])]))),
      el('div', { class: 'risk-legend' }, [
        el('span', {}, [el('span', { class: 'chip risk-safe' }, ['safe']), 'reads only: list, read, search, fetch']),
        el('span', {}, [el('span', { class: 'chip risk-write' }, ['write']), 'changes files, runs code, sends requests']),
        el('span', {}, [el('span', { class: 'chip risk-danger' }, ['danger']), 'destroys things: delete, merge']),
      ]),
      selectField('When executing a plan, use', 'planExecuteMode', [['default', 'Default permissions', 'writes and anything risky ask first'], ['auto', 'Allow all', 'the plan runs without prompts']]),
      toggle('Always ask, even for safe tools', 'alwaysAsk', null, { state: (v) => v ? 'Every single tool call waits for you. Thorough, and slow.' : 'Safe, read-only tools run without interrupting you.' }),
    ]));

    wrap.append(sec('Per-tool overrides', 'A tool the model cannot see is never called at all. A policy here beats the chat mode for that one tool — and "deny" wins everywhere, in every mode.', [
      el('div', { class: 'row gap wrap toolbar', id: 'set-disabledTools' }, [filter,
        el('button', { class: 'btn', type: 'button', onclick: () => bulk(t => { if (t.risk === 'safe' && !t.scope) H.perms.setRule(t.name, 'allow'); }) }, ['Allow all safe']),
        el('button', { class: 'btn', type: 'button', onclick: () => bulk(t => H.perms.setRule(t.name, 'default')) }, ['Reset policies']),
        el('button', { class: 'btn', type: 'button', onclick: () => { H.settings.set({ disabledTools: [] }); settingsRepaint?.(); } }, ['Enable all']),
        el('button', { class: 'btn', type: 'button', onclick: () => { H.perms.clearSession(); H.toast('Session grants cleared'); } }, ['Clear session grants'])]),
    ]));
    const siteRules = Object.entries(H.perms.rules()).filter(([k]) => k.includes('@'));
    wrap.append(sec('Site rules', 'web_fetch and http_request ask once per site. The answers you chose to keep — "Always allow this site", "Never allow this site" — are listed here.', [
      siteRules.length ? el('table', { class: 'table' }, [el('tbody', {}, siteRules.map(([k, v]) => { const [tool, origin] = [k.slice(0, k.indexOf('@')), k.slice(k.indexOf('@') + 1)]; return el('tr', {}, [el('td', { class: 'mono small' }, [tool]), el('td', { class: 'mono small' }, [origin]), el('td', {}, [el('span', { class: 'chip ' + (v === 'allow' ? 'ok' : 'danger') }, [v])]), el('td', {}, [el('button', { class: 'btn sm ghost', onclick: () => { H.perms.setRule(k, 'default'); settingsRepaint?.(); } }, ['Remove'])])]); }))])
        : el('p', { class: 'help' }, ['No site rules kept yet. Answers you give for one session only are forgotten when you start a new chat or reload.']),
    ]));
    for (const [g, tools] of Object.entries(groups)) {
      wrap.append(el('div', { class: 'group-title' }, [g, el('span', { class: 'count' }, [String(tools.length)])]));
      for (const t of tools) {
        const rule = H.perms.rules()[t.name] || 'default';
        wrap.append(el('div', { class: 'tool-row', 'data-k': (t.name + ' ' + t.description + ' ' + g).toLowerCase() }, [
          el('div', {}, [el('div', { class: 'row gap' }, [el('code', {}, [t.name]), el('span', { class: 'chip risk-' + t.risk }, [t.risk]), t.rerun ? el('span', { class: 'chip', title: 'You can re-run this tool from its card in the chat' }, ['re-runnable']) : null]), el('div', { class: 'desc' }, [t.description])]),
          el('label', { class: 'check small' }, [el('input', { type: 'checkbox', checked: !disabled.has(t.name), onchange: (e) => { const d = new Set(H.settings.get('disabledTools')); e.target.checked ? d.delete(t.name) : d.add(t.name); H.settings.set({ disabledTools: [...d] }); } }), 'enabled']),
          picker({
            variant: 'mini', value: rule, title: 'Policy for ' + t.name, search: false, wide: false,
            cls: (o) => o?.value === 'allow' ? 'allow' : o?.value === 'deny' ? 'deny' : '',
            options: [
              { value: 'default', label: 'mode default', short: `mode default (${H.perms.defaultFor(t)})`, sub: `follows the chat mode · ${H.perms.defaultFor(t)} for a ${t.risk} tool` },
              { value: 'allow', label: 'always allow', sub: 'runs silently in every mode' },
              { value: 'ask', label: 'always ask', sub: 'asks every time, even in Allow all' },
              { value: 'deny', label: 'deny', sub: 'never runs; deny always wins' },
            ],
            onpick: (v) => H.perms.setRule(t.name, v),
          }).el,
        ]));
      }
    }
    return wrap;
  }

  /* ---------- workspace ----------
     How the assistant reads and remembers the folder a chat is working in. Nothing here sends anything anywhere. */
  function workspacePanel() {
    const f = H.fs.folder();
    return el('div', {}, [
      sec('The folder a chat works in', null, [
        el('p', { class: 'sec-desc', style: 'margin:0 0 12px' }, [f
          ? `This chat is working in "${f.name}". The folder button under the message box switches it.`
          : 'No folder is open, so the file tools have nothing to work with. The folder button under the message box opens one.']),
        toggle('Follow the project\'s .gitignore', 'respectGitignore', null, {
          state: (v) => v ? 'Ignored files stay out of listings, searches and the code index — the same files git hides.' : 'Only the usual noise folders (node_modules, dist, build…) are skipped; everything else is fair game.',
        }),
        toggle('Load AGENTS.md / CLAUDE.md as project instructions', 'projectContextFile', null, {
          state: (v) => v ? 'A file with either name in the folder root becomes part of the system prompt. Turn this off for folders you do not trust.' : 'Instruction files in the folder are ignored, even if they are there.',
        }),
        toggle('Keep the previous contents of files the assistant changes', 'fileHistory', null, {
          state: (v) => v ? 'Every write is recorded so it can be undone from "Files changed in this chat" in the ⋯ menu. Kept in this browser and pruned as it grows.' : 'Writes cannot be undone — git here is read-only, so this is the only undo there is.',
        }),
      ]),
      advanced([
        stepper('Files in the search index', 'maxIndexFiles', { min: 1000, max: 200000, step: 1000, unit: 'files', help: 'An upper bound so a huge repository cannot fill this browser\'s memory. Files past the limit are simply not indexed; raise it for a very large monorepo.' }),
      ]),
    ]);
  }

  /* ---------- plugins ---------- */
  function pluginsPanel() {
    const wrap = el('div', {});
    const render = () => {
      wrap.innerHTML = '';
      wrap.append(sec('Plugins', 'Plugins add tools that call external APIs (REST) or remote MCP servers. Credentials are stored as secrets on this device and are only ever sent to the plugin\'s own URL.', []));
      for (const p of H.plugins.list()) {
        const configured = p.useLitellmKey ? !!H.settings.apiKey() : (p.route?.type === 'litellm' || p.route?.type === 'bridge' || p.route?.type === 'extension') ? !/your-domain|your-company|example\.com/.test(p.baseUrl || p.url || '') : p.kind === 'mcp' ? !!p.url && !/example\.com/.test(p.url) : !!(p.auth && (p.auth.token || p.auth.password || p.auth.value)) && !/your-domain|your-company|<.*>/.test(p.baseUrl || '');
        const card = el('div', { class: 'card plugin-card' });
        const status = el('span', { class: 'small muted' });
        card.append(el('div', { class: 'row gap wrap' }, [
          el('h4', {}, [p.name]), el('span', { class: 'chip' }, [p.kind.toUpperCase()]),
          el('span', { class: 'chip ' + (p.enabled ? 'on' : '') }, [p.enabled ? 'enabled' : 'disabled']),
          configured ? null : el('span', { class: 'chip risk-write' }, ['not set up']),
          el('span', { class: 'spacer' }),
          el('label', { class: 'check small' }, [el('input', { type: 'checkbox', checked: !!p.enabled, onchange: async (e) => { if (e.target.checked && !configured) { e.target.checked = false; setupWizard(p, render); return; } await H.plugins.setEnabled(p.id, e.target.checked); render(); } }), 'enabled']),
        ]));
        card.append(el('div', { class: 'small muted' }, [p.description || '']));
        card.append(el('div', { class: 'small mono muted' }, [p.kind === 'rest' ? `${p.baseUrl} · ${(p.tools || []).length} tools` : `${p.url || (p.useLitellmKey ? H.settings.get('baseUrl').replace(/\/+$/, '') + '/mcp/' : '')} · ${(H.plugins.tools().filter(t => t.plugin === p.id).length)} tools`, p.route?.type === 'litellm' ? ` · via LiteLLM /${p.route.path}` : p.route?.type === 'proxy' ? ' · via proxy' : p.route?.type === 'bridge' ? (H.bridge.has(p.baseUrl || p.url) ? ' · bridge connected' : ' · bridge (not connected)') : p.route?.type === 'extension' ? (H.ext.available() ? ' · via extension' : ' · via extension (not installed)') : '']));
        card.append(el('div', { class: 'row gap wrap', style: 'margin-top:10px' }, [
          el('button', { class: 'btn sm ' + (configured ? '' : 'primary'), onclick: () => setupWizard(p, render) }, [configured ? 'Configure' : 'Set up']),
          el('button', { class: 'btn sm', onclick: async () => { status.textContent = 'testing…'; try { status.textContent = '✓ ' + await H.plugins.test(p); } catch (e) { status.textContent = '✕ ' + e.message; } } }, ['Test']),
          el('button', { class: 'btn sm ghost', onclick: () => pluginJsonEditor(p, render) }, ['Edit manifest']),
          el('button', { class: 'btn sm ghost', onclick: () => H.download(p.id + '.plugin.json', JSON.stringify(H.plugins.exportSafe(p), null, 2), 'application/json') }, ['Export']),
          el('button', { class: 'btn sm danger-outline', onclick: () => { if (confirm('Remove plugin ' + p.name + '?')) { H.plugins.remove(p.id); render(); } } }, ['Remove']),
          status,
        ]));
        wrap.append(card);
      }
      wrap.append(el('div', { class: 'row gap wrap', style: 'margin-top:12px' }, [
        el('button', { class: 'btn', onclick: () => pluginJsonEditor({ ...H.deepClone(H.plugins.templates.mcp), id: 'mcp-' + H.uid().slice(0, 4) }, render) }, [H.icon('plus'), 'MCP server']),
        el('button', { class: 'btn', onclick: () => pluginJsonEditor({ id: 'api-' + H.uid().slice(0, 4), name: 'My API', kind: 'rest', enabled: false, baseUrl: 'https://api.example.com', auth: { type: 'bearer', token: '' }, headers: {}, tools: [{ name: 'ping', risk: 'safe', description: 'Example GET', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }, request: { method: 'GET', path: '/items/{{id}}' } }] }, render) }, [H.icon('plus'), 'REST plugin']),
        el('span', { class: 'spacer' }),
        picker({
          variant: 'mini', value: '', placeholder: 'Re-add template…', title: 'Add one of the built-in plugins back', search: false,
          options: [
            { value: 'jira', label: 'Jira Cloud', sub: 'REST API v3' }, { value: 'jira2', label: 'Jira Server / DC', sub: 'REST API v2' },
            { value: 'git', label: 'GitHub', sub: 'issues, pull requests, repositories' }, { value: 'gitlab', label: 'GitLab', sub: 'issues, merge requests, projects' },
            { value: 'litellmMcp', label: 'LiteLLM MCP gateway', sub: 'MCP servers your proxy exposes' },
          ],
          onpick: (v) => { H.plugins.upsert(H.deepClone(H.plugins.templates[v])); render(); },
        }).el,
        el('button', { class: 'btn', onclick: () => { const i = el('input', { type: 'file', accept: '.json' }); i.onchange = async () => { try { H.plugins.importJSON(await H.readFileAsText(i.files[0])); render(); H.toast('Imported', 'success'); } catch (e) { H.toast(e.message, 'error'); } }; i.click(); } }, ['Import JSON']),
      ]));
    };
    render();
    return wrap;
  }
  /* Guided setup: URL -> auth method -> credentials -> test -> enable */
  function setupWizard(p, done) {
    p = H.deepClone(p);
    const setup = p.setup || (p.kind === 'mcp' ? { urlLabel: 'MCP endpoint URL', urlPlaceholder: 'https://host/mcp', auth: [{ type: 'header', label: 'Authorization header', fields: [{ key: 'value', label: 'Header value, e.g. Bearer xyz', secret: true }], fixedName: 'Authorization' }, { type: 'none', label: 'No authentication', fields: [] }] } : { urlLabel: 'Base URL', urlPlaceholder: 'https://api.example.com', auth: [{ type: 'bearer', label: 'Bearer token', fields: [{ key: 'token', label: 'Token', secret: true }] }, { type: 'basic', label: 'Username + password', fields: [{ key: 'username', label: 'Username' }, { key: 'password', label: 'Password', secret: true }] }, { type: 'header', label: 'Custom header', fields: [{ key: 'name', label: 'Header name' }, { key: 'value', label: 'Value', secret: true }] }, { type: 'none', label: 'No authentication', fields: [] }] });
    const ov = el('div', { class: 'modal-overlay' });
    const urlKey = p.kind === 'mcp' ? 'url' : 'baseUrl';
    const url = el('input', { type: 'url', value: /your-domain|your-company|example\.com/.test(p[urlKey] || '') && !/api\.github\.com/.test(p[urlKey]) ? '' : (p[urlKey] || ''), placeholder: setup.urlPlaceholder || '', autocomplete: 'off' });
    const authIdx = Math.max(0, setup.auth.findIndex(a => a.type === p.auth?.type));
    const authPick = picker({ value: authIdx, title: 'Authentication', search: false, options: setup.auth.map((a, i) => ({ value: i, label: a.label })), onpick: () => renderCreds() });
    const credBox = el('div', {});
    const result = el('div', { class: 'setup-result hidden' });
    let curAuth = setup.auth.find(a => a.type === p.auth?.type) || setup.auth[0];
    const renderCreds = () => {
      curAuth = setup.auth[+authPick.value] || setup.auth[0]; credBox.innerHTML = '';
      if (curAuth.help || curAuth.link) credBox.append(el('p', { class: 'help' }, [curAuth.help || '', ' ', curAuth.link ? el('a', { href: curAuth.link.replace('{{baseUrl}}', url.value.replace(/\/+$/, '')), target: '_blank', rel: 'noopener' }, ['Open token page ', H.icon('external')]) : null]));
      for (const f of curAuth.fields) {
        const existing = p.kind === 'mcp' ? (p.headers?.Authorization || '') : (p.auth?.[f.key] || '');
        credBox.append(el('label', { class: 'field' }, [el('span', {}, [f.label]), el('input', { type: f.secret ? 'password' : 'text', 'data-key': f.key, value: /^<.*>$/.test(existing) ? '' : existing, autocomplete: 'off' })]));
      }
    };
    renderCreds();
    /* connection route */
    const route = p.route || { type: 'direct' };
    const litellmBase = H.settings.get('baseUrl').replace(/\/+$/, '');
    const rPath = el('input', { type: 'text', value: route.path || p.id, placeholder: p.id });
    const rProxy = el('input', { type: 'url', value: route.proxyUrl || '', placeholder: 'https://proxy.example.com/?url={url}' });
    const snippet = el('pre', { class: 'perm-args small' });
    const routeDetail = el('div', {});
    const routeSel = picker({ value: route.type || 'direct', title: 'Connection route', search: false, onpick: () => renderRoute(), options: [
      { value: 'bridge', label: 'Browser session bridge', sub: 'a bookmarklet in a logged-in tab — recommended' },
      { value: 'direct', label: 'Direct from the browser', sub: 'only if the API allows CORS' },
      { value: 'extension', label: 'Connector extension', sub: H.ext.available() ? 'installed ✓' : 'only if you may load extensions' },
      { value: 'litellm', label: 'LiteLLM pass-through endpoint', sub: 'needs a proxy admin to add it' },
      { value: 'proxy', label: 'A CORS proxy I trust', sub: 'the proxy sees the whole request' },
    ] });
    const renderRoute = () => {
      routeDetail.innerHTML = '';
      if (routeSel.value === 'litellm') {
        const path = rPath.value.trim().replace(/^\/+|\/+$/g, '') || p.id;
        snippet.textContent = `# LiteLLM config.yaml (ask your LiteLLM admin)\ngeneral_settings:\n  pass_through_endpoints:\n    - path: "/${path}"\n      target: "${url.value.trim().replace(/\/+$/, '') || '<API base URL>'}"\n      headers:\n        ${curAuth.type === 'basic' ? 'Authorization: "Basic <base64 of email:api-token>"' : curAuth.type === 'header' ? (curAuth.fixedName || '<Header-Name>') + ': "<token>"' : 'Authorization: "Bearer <token>"'}\n        Accept: "application/json"`;
        const tryBtn = el('button', { class: 'btn sm', onclick: async () => { collect(); tryBtn.disabled = true; try { await H.plugins.createPassThrough(p, path); H.toast('Pass-through endpoint created on the proxy. Test the connection now.', 'success', 8000); } catch (e) { H.toast(e.message, 'error', 10000); } finally { tryBtn.disabled = false; } } }, ['Try to create it with my key']);
        routeDetail.append(el('label', { class: 'field' }, [el('span', {}, ['Pass-through path on the proxy']), rPath]),
          el('p', { class: 'help' }, [`Requests go to ${litellmBase}/${path}/… with your LiteLLM key; the proxy adds the API credentials and forwards to the API. Fill in step 2 with the API token, then either create the endpoint yourself (works if your key has admin rights) or give the snippet to the LiteLLM admin.`]), el('div', { class: 'row gap', style: 'margin:6px 0' }, [tryBtn]), snippet);
      } else if (routeSel.value === 'extension') {
        const target = (() => { try { return new URL(url.value.trim()).origin; } catch { return '(enter the URL above)'; } })();
        const status = el('div', { class: 'setup-result ' + (H.ext.available() ? 'ok' : 'err') }, [H.ext.available() ? `✓ Extension installed (v${H.ext.version()}). Make sure ${target} is in its allowed sites.` : '✕ Extension not detected on this page.']);
        H.bus.on('ext', () => { status.className = 'setup-result ok'; status.textContent = `✓ Extension installed (v${H.ext.version()}). Make sure ${target} is in its allowed sites.`; });
        routeDetail.append(
          el('p', { class: 'help' }, ['A tiny extension (in the "extension" folder of the harness download) performs the REST calls for allowed sites, with your browser login or the token from step 2. No tab to keep open, no admin, survives sleep and navigation.']),
          el('ol', { class: 'help-list' }, [
            el('li', {}, ['Open ', el('code', {}, ['chrome://extensions']), ' (Edge: ', el('code', {}, ['edge://extensions']), '), switch on ', el('b', {}, ['Developer mode']), ' (top right).']),
            el('li', {}, ['Click ', el('b', {}, ['Load unpacked']), ' and choose the ', el('code', {}, ['extension']), ' folder of the harness.', !/^https?:/.test(location.origin) ? ' Then open the extension\'s Details and enable "Allow access to file URLs" (the harness runs from a file).' : '']),
            el('li', {}, ['Click the extension icon (puzzle piece) → Web LLM Harness Connector. Under "Harness page" add ', el('code', {}, [/^https?:/.test(location.origin) ? location.origin : 'file://']), '; under "APIs it may call" add ', el('code', {}, [target]), '. Then reload this page. ', el('button', { class: 'btn sm', onclick: () => { H.ext.openOptions(); } }, ['Open options'])]),
          ]),
          status,
          el('p', { class: 'help' }, ['If your company blocks Developer mode in the browser, fall back to the bookmark bridge.']),
        );
      } else if (routeSel.value === 'bridge') {
        const target = (() => { try { return new URL(url.value.trim()).origin; } catch { return '(enter the URL above)'; } })();
        if (!H.bridge.usable()) { routeDetail.append(el('div', { class: 'note' }, ['The bridge is not available: this browser could not create the signing identity the bridge needs when the harness is opened from a file (Web Crypto or IndexedDB unavailable). Use Chrome, Edge or Firefox, or put the folder on any http(s) address.'])); return; }
        const status = el('div', { class: 'setup-result' });
        const upd = () => { const old = H.bridge.legacy(target); if (old) { status.className = 'setup-result err'; status.textContent = `⚠ The ${target.replace(/^https?:\/\//, '')} tab clicked an OLD bridge bookmark${old === 'refused' ? ', which cannot connect to a harness opened from a file' : ' (it works, but unencrypted)'}. Drag the bookmark below to your bookmarks bar again (replace the old one), then click the new one on that tab.`; return; } const ok = H.bridge.list().find(b => b.origin === target); status.className = 'setup-result ' + (ok ? 'ok' : ''); status.textContent = ok ? `✓ Bridge connected to ${target}` + (ok.mode === 'opener' ? ' (linked tab' : ok.mode ? ` (${ok.mode}` : ' (') + (ok.tabs > 1 ? `, ${ok.tabs} tabs)` : ')') : `Waiting for a bridge from ${target}…\nIf the ${target.replace(/^https?:\/\//, '')} tab already shows a blue bar but nothing happens here, that bar connected to a different harness window (it says "NEW harness window" or "PANEL MODE"). Use the Open button in step 2 below and click the bookmark on the tab it opens: that tab is linked to this one.`; };
        upd(); const off = H.bus.on('bridge', upd); const iv = setInterval(() => { if (!document.body.contains(status)) { off(); off2(); clearInterval(iv); } else upd(); }, 2000);
        const trace = el('div', { class: 'setup-result hidden mono small' });
        let waitTimer = null;
        const off2 = H.bus.on('bridge-request', (r) => { if (r.origin !== target) return; clearInterval(waitTimer); trace.classList.remove('hidden'); trace.className = 'setup-result mono small ' + (r.phase === 'done' ? 'ok' : r.phase === 'sent' ? '' : 'err');
          if (r.phase === 'sent') { const t0 = Date.now(); const paint = () => trace.textContent = `→ sent to the ${target.replace(/^https?:\/\//, '')} tab: ${r.url.replace(target, '')} … waiting ${Math.round((Date.now() - t0) / 1000)} s (the blue bar there should show "received")`; paint(); waitTimer = setInterval(paint, 1000); }
          else trace.textContent = r.phase === 'done' ? `✓ answered: HTTP ${r.status} in ${r.ms} ms (${r.url.replace(target, '')})` : `✕ ${r.phase}: ${r.error || 'no answer within 20 s'}`; });
        const diagBtn = el('button', { class: 'btn sm ghost', onclick: () => { navigator.clipboard.writeText(H.bridge.diagnostics()); H.toast('Diagnostics copied to clipboard', 'success'); } }, ['Copy diagnostics']);
        const pingBtn = el('button', { class: 'btn sm', onclick: async () => { pingBtn.disabled = true; try { const r = await H.bridge.ping(target); H.toast(`Bridge ping OK: HTTP ${r.status}, ${r.bytes} bytes from ${target}`, 'success', 6000); } catch (e) { H.toast('Bridge ping failed: ' + e.message, 'error', 10000); } finally { pingBtn.disabled = false; } } }, ['Ping bridge']);
        const link = el('a', { class: 'btn primary bookmarklet', href: H.bridge.bookmarklet(), draggable: true, title: 'Drag me to your bookmarks bar', onclick: (e) => { e.preventDefault(); H.toast('Drag this button to your bookmarks bar (or use Copy and create a bookmark with that address).', 'info', 6000); } }, [H.icon('link'), 'LLM Harness bridge']);
        routeDetail.append(
          el('ol', { class: 'help-list' }, [
            el('li', {}, ['Drag this button to your bookmarks bar: ', link, ' ', el('button', { class: 'btn sm ghost', onclick: () => { navigator.clipboard.writeText(H.bridge.bookmarklet()); H.toast('Bookmarklet copied. Create a bookmark and paste it as the address.', 'success'); } }, ['Copy']), el('span', { class: 'help', style: 'margin:2px 0 0' }, [`Do it once; the same bookmark works for every site. It is bound to this harness address (${!/^https?:/.test(location.origin) ? 'file://' : location.origin}); if you move the harness, drag it again.`])]),
            el('li', {}, [el('b', {}, ['Important: ']), 'open the site from this button, so the new tab is linked to this harness tab: ', el('button', { class: 'btn sm primary', onclick: () => { if (target.startsWith('http')) H.bridge.openSite(target); else H.toast('Enter the site URL first', 'warn'); } }, [H.icon('external'), `Open ${target.replace(/^https?:\/\//, '')}`]), ' Log in there if needed. A tab you opened yourself is not linked.']),
            el('li', {}, ['On that new tab, click the bookmark. The blue bar must say "linked to your harness tab ✓". Keep that tab open and ', el('b', {}, ['do not browse in it']), ': every full page load in that tab drops the bookmark script (click it again if the bar disappears). Do your normal Jira work in another tab.']),
          ]),
          el('div', { class: 'row gap', style: 'margin-top:8px' }, [status, pingBtn, diagBtn]), trace,
          el('p', { class: 'help' }, ['Stays connected while the tab exists, even in the background. It drops when the tab is closed, reloaded, navigated, or put to sleep by the browser. Two ways to stop the browser from sleeping it: (a) Chrome: Settings → Performance → "Always keep these sites active" (Edge: Settings → System and performance → "Never put these sites to sleep"); (b) click "keep awake" in the blue bar: the tab then plays an inaudible tone, which browsers treat as active audio and never discard. The pill in the top bar checks the link when clicked.']),
          el('p', { class: 'help' }, ['No popups are needed: the bookmark links back to this tab. If the tabs are not linked (for example you opened the site yourself), it tries a popup, and if that is blocked it opens the harness as a side panel inside the site\'s page instead (that panel has its own settings, so enter your LiteLLM details there once). Requests run with your normal login, so keep "My browser login session" in step 2.' + (!/^https?:/.test(location.origin) ? ' Note: this app is opened via file://, so the bridge cannot verify the harness origin; host it on an http(s) URL for full security.' : '')]),
        );
      } else if (routeSel.value === 'proxy') {
        routeDetail.append(el('label', { class: 'field' }, [el('span', {}, ['Proxy URL ({url} = encoded target, or a prefix)']), rProxy]), el('p', { class: 'help' }, ['The proxy sees the full request including credentials. Only use one you or your company operates.']));
      } else routeDetail.append(el('p', { class: 'help' }, [`Works for APIs that send CORS headers for this page's origin (${!/^https?:/.test(location.origin) ? 'none: file:// pages have origin "null"' : location.origin}): GitHub, GitLab, and Jira Server / Data Center once its admin allowlists the origin. Jira Cloud never does.`]));
    };
    rPath.oninput = renderRoute; url.addEventListener('input', renderRoute);
    const collect = () => {
      p[urlKey] = url.value.trim().replace(/\/+$/, '');
      p.route = routeSel.value === 'direct' ? { type: 'direct' } : routeSel.value === 'extension' ? { type: 'extension' } : routeSel.value === 'bridge' ? { type: 'bridge' } : routeSel.value === 'litellm' ? { type: 'litellm', path: rPath.value.trim().replace(/^\/+|\/+$/g, '') || p.id } : { type: 'proxy', proxyUrl: rProxy.value.trim() };
      const vals = {}; credBox.querySelectorAll('input[data-key]').forEach(i => vals[i.dataset.key] = i.value.trim());
      if (p.kind === 'mcp') { p.headers = { ...(p.headers || {}) }; if (curAuth.type === 'none') delete p.headers.Authorization; else p.headers.Authorization = vals.value; if (p.useLitellmKey && !p[urlKey]) p[urlKey] = ''; }
      else p.auth = curAuth.type === 'none' ? { type: 'none' } : { type: curAuth.type, ...(curAuth.fixedName ? { name: curAuth.fixedName } : {}), ...vals };
    };
    const testBtn = el('button', { class: 'btn', onclick: async () => {
      collect(); result.classList.remove('hidden'); result.className = 'setup-result'; result.textContent = 'Testing connection…';
      try { const t = await H.plugins.test(p); result.classList.add('ok'); result.textContent = '✓ ' + t; }
      catch (e) { result.classList.add('err'); result.textContent = '✕ ' + e.message; }
    } }, ['Test connection']);
    const save = async (enable) => { collect(); if (enable) p.enabled = true; H.plugins.upsert(p); if (enable && p.kind === 'mcp') await H.plugins.setEnabled(p.id, true); ov.remove(); done(); H.toast(enable ? p.name + ' enabled' : 'Saved', 'success'); };
    ov.append(el('div', { class: 'modal setup' }, [
      el('div', { class: 'modal-head' }, [el('h3', {}, ['Set up ' + p.name]), el('span', { class: 'spacer' }), el('button', { class: 'btn icon ghost', onclick: () => ov.remove() }, [H.icon('x')])]),
      el('p', { class: 'small muted' }, [p.description || '']),
      setup.warning ? el('div', { class: 'note' }, [setup.warning]) : null,
      el('div', { class: 'step' }, [el('div', { class: 'step-n' }, ['1']), el('div', { class: 'step-body' }, [el('label', { class: 'field' }, [el('span', {}, [setup.urlLabel || 'URL']), url]), setup.urlHelp ? el('p', { class: 'help' }, [setup.urlHelp]) : null])]),
      el('div', { class: 'step' }, [el('div', { class: 'step-n' }, ['2']), el('div', { class: 'step-body' }, [el('div', { class: 'field' }, [el('span', {}, ['Authentication']), authPick.el]), credBox, el('p', { class: 'help' }, ['Credentials are stored as a secret in this browser only and sent solely to the URL above.'])])]),
      el('div', { class: 'step' }, [el('div', { class: 'step-n' }, ['3']), el('div', { class: 'step-body' }, [el('div', { class: 'field' }, [el('span', {}, ['Connection route']), routeSel.el]), routeDetail])]),
      el('div', { class: 'step' }, [el('div', { class: 'step-n' }, ['4']), el('div', { class: 'step-body' }, [el('div', { class: 'row gap' }, [testBtn]), result])]),
      el('div', { class: 'row gap', style: 'margin-top:14px' }, [el('button', { class: 'btn primary', onclick: () => save(true) }, ['Save & enable']), el('button', { class: 'btn', onclick: () => save(false) }, ['Save only']), el('span', { class: 'spacer' }), el('button', { class: 'btn ghost', onclick: () => ov.remove() }, ['Cancel'])]),
    ]));
    document.body.append(ov); renderCreds(); renderRoute(); url.focus();
  }
  function pluginJsonEditor(p, done) {
    const ov = el('div', { class: 'modal-overlay' });
    const ta = el('textarea', { class: 'json-editor', rows: 24 }, [JSON.stringify(p, null, 2)]);
    const err = el('div', { class: 'small', style: 'color:var(--danger)' });
    ov.append(el('div', { class: 'modal wide' }, [el('div', { class: 'modal-head' }, [el('h3', {}, ['Plugin manifest: ' + p.id]), el('span', { class: 'spacer' }), el('button', { class: 'btn icon ghost', onclick: () => ov.remove() }, [H.icon('x')])]),
      el('p', { class: 'small muted' }, ['REST tools: { name, description, risk, parameters (JSON schema), request: { method, path, query, headers, body, raw }, defaults, transform (JS expression over `data`), prepare (JS fn over args), pathFn }. Templates use {{param}} and {{json param}}. Secrets in auth/headers are moved to the secret store on save.']),
      ta, err,
      el('div', { class: 'row gap' }, [el('button', { class: 'btn primary', onclick: () => { try { const j = JSON.parse(ta.value); if (!j.id || !j.kind) throw new Error('id and kind are required'); if (j.id !== p.id) H.plugins.remove(p.id); H.plugins.upsert(j); ov.remove(); done(); } catch (e) { err.textContent = e.message; } } }, ['Save']), el('button', { class: 'btn', onclick: () => ov.remove() }, ['Cancel'])])]));
    document.body.append(ov);
  }

  /* ---------- skills ---------- */
  function skillsPanel() {
    const wrap = el('div', {});
    const render = () => {
      wrap.innerHTML = '';
      const all = H.skills.list();
      wrap.append(sec('Skills', 'Reusable instruction sets. Type /name in the chat, or let the model load one via use_skill when a request matches its description. Write one yourself, draft one with the model in the editor, or ask for one in the chat — the model writes skills with skill_write.', []));
      if (!all.length) wrap.append(el('p', { class: 'sec-desc' }, ['No skills yet. Write one below, ask the model for one in the chat, or import a markdown file with name/description frontmatter.']));
      for (const s of all) {
        const prev = H.skills.prevOf(s.name);
        wrap.append(el('div', { class: 'card' }, [
          el('div', { class: 'row gap' }, [el('h4', {}, ['/' + s.name]), prev ? el('span', { class: 'chip' }, ['written by the model']) : null, el('span', { class: 'spacer' }),
            el('button', { class: 'btn sm', onclick: () => skillEditor(s, render) }, ['Edit']),
            prev ? el('button', { class: 'btn sm ghost', title: prev.skill ? 'Put back the version from before the model last wrote this skill' : 'The model created this skill; remove it again', onclick: () => { H.skills.revert(s.name); H.toast(prev.skill ? `/${s.name} put back` : `/${s.name} removed`, 'success'); render(); } }, [H.icon('refresh'), 'Revert']) : null,
            el('button', { class: 'btn sm ghost', onclick: () => H.download(s.name + '.md', H.skills.serialize(s), 'text/markdown') }, ['Export']),
            el('button', { class: 'btn sm danger-outline', onclick: () => { if (confirm('Delete skill ' + s.name + '?')) { H.skills.remove(s.name); render(); } } }, ['Delete'])]),
          el('div', { class: 'small muted' }, [s.description]),
        ]));
      }
      wrap.append(el('div', { class: 'row gap wrap', style: 'margin-top:12px' }, [
        el('button', { class: 'btn', onclick: () => skillEditor({ name: '', description: '', content: '' }, render) }, [H.icon('plus'), 'New skill']),
        el('button', { class: 'btn', onclick: () => { settingsClose?.(); $('#input').value = 'Write me a skill that '; autoresize(); $('#input').focus(); $('#input').setSelectionRange($('#input').value.length, $('#input').value.length); } }, [H.icon('bolt'), 'Ask in the chat']),
        el('button', { class: 'btn', onclick: () => { const i = el('input', { type: 'file', accept: '.md,.txt', multiple: true }); i.onchange = async () => { for (const f of i.files) H.skills.upsert(H.skills.parse(await H.readFileAsText(f), f.name.replace(/\.\w+$/, ''))); render(); }; i.click(); } }, ['Import .md']),
      ]));
    };
    render();
    /* a skill written from a chat while this dialog is open should appear here, not on the next visit */
    const off = H.bus.on('skills', () => { if (wrap.isConnected) render(); else off(); });
    return wrap;
  }
  function skillEditor(s, done) {
    const orig = s.name; s = H.deepClone(s);
    const ov = el('div', { class: 'modal-overlay' });
    const name = el('input', { type: 'text', value: s.name, placeholder: 'kebab-case-name' }), desc = el('input', { type: 'text', value: s.description, placeholder: 'One-line description (shown to the model)' }), body = el('textarea', { rows: 14, class: 'mono' }, [s.content]);
    const draft = draftRow(orig, { name, desc, body });
    ov.append(el('div', { class: 'modal wide' }, [el('h3', {}, [orig ? 'Edit skill' : 'New skill']),
      el('label', { class: 'field' }, [el('span', {}, ['Name']), name]), el('label', { class: 'field' }, [el('span', {}, ['Description']), desc]),
      draft.node,
      el('label', { class: 'field' }, [el('span', {}, ['Instructions (markdown)']), body]),
      el('div', { class: 'row gap' }, [el('button', { class: 'btn primary', onclick: () => { const v = H.skills.validate(name.value); if (!v.ok) return H.toast(v.error, 'warn', 6000); if (v.name !== orig && H.skills.get(v.name) && !confirm(`/${v.name} already exists. Replace it?`)) return; draft.stop(); if (orig && orig !== v.name) H.skills.remove(orig); H.skills.upsert({ name: v.name, description: desc.value.trim(), content: body.value }); ov.remove(); done(); } }, ['Save']), el('button', { class: 'btn', onclick: () => { draft.stop(); ov.remove(); } }, ['Cancel'])])]));
    document.body.append(ov);
  }
  /* One-shot model call, no tools: describe the skill, the reply streams into the Instructions box.
     Nothing is saved until the user clicks Save, and the text that was there before is one click away. */
  const SKILL_AUTHOR_PROMPT = `You write skills for a browser-based LLM harness. A skill is a reusable instruction set the user invokes by typing /name in the chat box, and that the assistant can also load by itself when a request matches the description.
Reply with the skill file and nothing else: no preamble, no closing remark, and no code fence around the file. The file is:
---
name: kebab-case-name
description: one line saying when to use it
---
then the instructions in markdown.
Address the assistant in the second person. Give concrete, ordered steps, name the tools to call where it matters, and say how to present the result. Keep it tight: a skill is a checklist, not an essay.`;
  function draftRow(orig, { name, desc, body }) {
    const prompt = el('input', { type: 'text', placeholder: orig ? 'How should this skill change? e.g. also check the branch name' : 'What should this skill do? e.g. turn my git log into a standup note' });
    const go = el('button', { class: 'btn', type: 'button' }, [H.icon('bolt'), 'Draft with the model']);
    const undo = el('button', { class: 'btn ghost hidden', type: 'button', title: 'Put back the instructions from before the draft' }, [H.icon('refresh'), 'Revert draft']);
    const note = el('div', { class: 'small muted' }, []);
    let ctrl = null, before = null;
    const stop = () => { ctrl?.abort(); ctrl = null; };
    const idle = () => { ctrl = null; go.innerHTML = ''; go.append(H.icon('bolt'), 'Draft with the model'); go.classList.remove('danger-outline'); prompt.disabled = false; };
    go.onclick = async () => {
      if (ctrl) return stop();
      const ask = prompt.value.trim();
      if (!ask) { prompt.focus(); return; }
      if (!H.settings.apiKey()) return H.toast('No API key configured (Settings › General).', 'warn', 5000);
      before = body.value; undo.classList.add('hidden');
      ctrl = new AbortController(); const signal = ctrl.signal;
      go.innerHTML = ''; go.append(H.icon('stop'), 'Stop'); go.classList.add('danger-outline'); prompt.disabled = true;
      note.textContent = 'Drafting…';
      const current = orig ? `The skill as it stands today:\n\n${H.skills.serialize({ name: name.value.trim() || orig, description: desc.value.trim(), content: body.value })}\n\nRewrite it whole, keeping what still works.\n\n` : '';
      body.value = '';
      let text = '', stopped = false;
      try {
        await H.llm.chat({
          messages: [{ role: 'system', content: SKILL_AUTHOR_PROMPT }, { role: 'user', content: current + 'What the skill should do:\n' + ask }],
          temperature: 0.3, signal,
          onDelta: (d) => { if (d.content) { text += d.content; body.value = text; body.scrollTop = body.scrollHeight; } },
        });
      } catch (e) {
        if (e.name !== 'AbortError') { body.value = before; note.textContent = ''; idle(); return H.toast(H.explainError(e), 'error', 8000); }
        stopped = true;
      }
      /* nothing arrived: the box goes back to what it held, so a stop or an empty reply costs the user nothing */
      if (!text.trim()) { body.value = before; note.textContent = stopped ? 'Stopped before anything arrived.' : 'The model returned nothing.'; undo.classList.add('hidden'); return idle(); }
      /* whatever did arrive — a whole file, or the part that streamed before Stop — is parsed the same way */
      const parsed = H.skills.parse(text.replace(/^\s*```(?:md|markdown)?\s*\n|\n```\s*$/g, '').trim());
      body.value = parsed.content;
      if (parsed.name && parsed.name !== 'skill' && (!name.value.trim() || !orig)) name.value = parsed.name;
      if (parsed.description && !desc.value.trim()) desc.value = parsed.description;
      note.textContent = stopped ? 'Stopped part-way. Finish it yourself, or draft again.' : 'Draft written. Read it, change what you like, then Save.';
      undo.classList.remove('hidden');
      idle();
    };
    undo.onclick = () => { body.value = before ?? ''; undo.classList.add('hidden'); note.textContent = ''; };
    prompt.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go.click(); } });
    return {
      stop,
      node: el('div', { class: 'field' }, [el('span', {}, [orig ? 'What should change' : 'What it should do']), el('div', { class: 'input-row draft-row' }, [prompt, go, undo]), note]),
    };
  }

  /* ---------- usage ---------- */
  function usagePanel() {
    const wrap = el('div', {});
    const stat = (label, value, sub) => el('div', { class: 'stat' }, [el('div', { class: 'stat-v' }, [value]), el('div', { class: 'stat-l' }, [label]), sub ? el('div', { class: 'stat-s' }, [sub]) : null]);
    /* the chat you are in is covered by the popup on the ring under the message box; this page is the
       cross-chat view, so it starts at the all-time figures */
    const model = H.settings.get('model'); const p = H.usage.priceFor(model);
    const totalBox = el('div', {}, [el('p', { class: 'muted small' }, ['Loading…'])]);
    wrap.append(sec('All time (this browser)', 'Aggregated over every request made from this device, including deleted chats.', [totalBox]));
    (async () => {
      const t = await H.usage.loadTotal(); const agg = await H.usage.aggregateChats();
      totalBox.innerHTML = '';
      const models = Object.entries(t.byModel).sort((a, b) => b[1].prompt + b[1].completion - a[1].prompt - a[1].completion);
      const totalCost = models.reduce((acc, [m, v]) => acc + (H.usage.cost(m, v.prompt, v.completion, v.cached || 0) || 0), 0);
      totalBox.append(el('div', { class: 'stats' }, [stat('Requests', String(t.requests)), stat('Input tokens', H.usage.fmtTok(t.prompt)), stat('Output tokens', H.usage.fmtTok(t.completion)), stat('Cost', H.usage.fmtCost(totalCost), `${agg.chats} chats stored · at current prices`)]));
      if (models.length) totalBox.append(el('table', { class: 'table' }, [el('thead', {}, [el('tr', {}, ['Model', 'Requests', 'Input', 'Output', 'Cost'].map(h => el('th', {}, [h])))]), el('tbody', {}, models.map(([m, v]) => { const c = H.usage.cost(m, v.prompt, v.completion, v.cached || 0); return el('tr', {}, [el('td', { class: 'mono' }, [m]), el('td', {}, [String(v.requests)]), el('td', {}, [H.usage.fmtTok(v.prompt) + (v.cached ? ` (${H.usage.fmtTok(v.cached)} cached)` : '')]), el('td', {}, [H.usage.fmtTok(v.completion)]), el('td', {}, [c == null ? 'set pricing' : H.usage.fmtCost(c)])]); }))]));
      const days = Object.entries(t.byDay).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 14);
      if (days.length) { const max = Math.max(...days.map(([, v]) => v.prompt + v.completion)); totalBox.append(el('div', { class: 'bars' }, days.reverse().map(([d, v]) => el('div', { class: 'bar', title: `${d}: ${(v.prompt + v.completion).toLocaleString()} tokens · ${H.usage.fmtCost(v.cost)}` }, [el('div', { class: 'bar-fill', style: `height:${Math.max(3, (v.prompt + v.completion) / max * 60)}px` }), el('span', {}, [d.slice(5)])])))); }
      if (agg.top.length) totalBox.append(el('table', { class: 'table' }, [el('thead', {}, [el('tr', {}, ['Most expensive chats', 'Tokens', 'Cost'].map(h => el('th', {}, [h])))]), el('tbody', {}, agg.top.map(c => el('tr', {}, [el('td', {}, [el('a', { href: '#', onclick: (e) => { e.preventDefault(); settingsModal?.remove(); settingsModal = null; H.agent.load(c.id); } }, [c.title])]), el('td', {}, [H.usage.fmtTok(c.tokens)]), el('td', {}, [H.usage.fmtCost(c.cost)])])))]));
      totalBox.append(el('div', { class: 'row gap', style: 'margin-top:10px' }, [el('button', { class: 'btn sm danger-outline', onclick: async () => { if (confirm('Reset all-time usage counters?')) { await H.usage.resetTotal(); settingsRepaint?.(); } } }, ['Reset counters'])]));
    })();
    wrap.append(sec('Model prices', `Prices come from your proxy's /model/info where it offers them — for the model you are using now, they were ${p.source === 'litellm' ? 'found there' : p.source === 'manual' ? 'set by hand below' : 'not found, so no cost can be shown'}. Fill in a row for any model your proxy does not price.`, [
      priceEditor(),
      el('div', { class: 'row gap', style: 'margin-top:10px' }, [el('button', { class: 'btn', onclick: async () => { const i = await H.usage.refreshModelInfo(); H.toast(i ? `Model info loaded for ${Object.keys(i).length} models` : 'No /model/info endpoint available', i ? 'success' : 'warn'); settingsRepaint?.(); } }, [H.icon('refresh'), 'Refresh from LiteLLM'])]),
    ]));
    return wrap;
  }
  /* Prices used to be a raw JSON textarea. Same stored shape ({ model: { in, out, cached, context } }, USD per
     1M tokens), now as rows you can fill in — with the textarea kept under Advanced for pasting a whole block. */
  function priceEditor() {
    const box = el('div', { id: 'set-pricing' });
    const render = () => {
      const pricing = { ...(H.settings.get('pricing') || {}) };
      const rows = Object.entries(pricing);
      box.innerHTML = '';
      const save = (v) => { H.settings.set({ pricing: v }); updateContextMeter(); };
      /* every handler re-reads what is stored: filling in three cells of one row must not have each edit
         overwrite the last one from a snapshot taken when the table was drawn */
      const cur = () => ({ ...(H.settings.get('pricing') || {}) });
      const setNum = (m, k, nv) => { const p = cur(); const e = { ...(p[m] || {}) }; if (nv === '') delete e[k]; else e[k] = +nv; p[m] = e; save(p); };
      const cell = (val, ph, on) => el('input', { type: 'text', inputmode: 'decimal', value: val ?? '', placeholder: ph, onchange: (e) => on(e.target.value.trim()) });
      const table = el('table', { class: 'table price-table' }, [
        el('thead', {}, [el('tr', {}, ['Model', '$ / 1M in', '$ / 1M out', '$ / 1M cached', 'Context', ''].map(h => el('th', {}, [h])))]),
        el('tbody', {}, rows.map(([m, v]) => el('tr', {}, [
          el('td', {}, [cell(m, 'model name', (nv) => { if (!nv || nv === m) return render(); const p = cur(); p[nv] = p[m] || {}; delete p[m]; save(p); render(); })]),
          ...['in', 'out', 'cached'].map(k => el('td', {}, [cell(v[k], '—', (nv) => setNum(m, k, nv))])),
          el('td', {}, [cell(v.context, 'tokens', (nv) => setNum(m, 'context', nv))]),
          el('td', {}, [el('button', { class: 'btn sm ghost', title: 'Remove this model', onclick: () => { const p = cur(); delete p[m]; save(p); render(); } }, ['Remove'])]),
        ]))),
      ]);
      box.append(rows.length ? table : el('p', { class: 'help' }, ['No prices set by hand. Everything is priced from the proxy, or not priced at all.']));
      const add = el('input', { type: 'text', class: 'price-add', placeholder: 'Model name…', onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); addRow(); } } });
      const addRow = () => { const n = add.value.trim(); if (!n) return; save({ ...pricing, [n]: {} }); render(); };
      box.append(el('div', { class: 'input-row', style: 'margin-top:10px' }, [add, el('button', { class: 'btn', type: 'button', onclick: addRow }, [H.icon('plus'), 'Add model'])]));
      box.append(advanced([
        el('p', { class: 'help' }, ['The same prices as JSON, for pasting a whole block at once. USD per 1M tokens.']),
        el('textarea', { rows: 5, class: 'mono', placeholder: '{ "gpt-4o": { "in": 2.5, "out": 10, "cached": 1.25, "context": 128000 } }', onchange: (e) => { try { save(e.target.value.trim() ? JSON.parse(e.target.value) : {}); H.toast('Prices saved', 'success'); render(); } catch (err) { H.toast('That is not valid JSON: ' + err.message, 'error'); } } }, [rows.length ? JSON.stringify(pricing, null, 2) : '']),
      ], 'Paste as JSON'));
    };
    render();
    return box;
  }

  /* ---------- web access ----------
     Everything that makes this browser talk to a host other than your proxy. The table of who that is right now
     comes first, because it is the evidence for the switches underneath it. */
  /* presets for the search template: web_search stays off until one of these is filled in */
  const SEARCH_PRESETS = [
    { value: 'off', label: 'Off', sub: 'web_search is not offered to the model' },
    { value: 'searxng', label: 'SearXNG (self-hosted)', sub: 'queries stay on your own instance', tpl: 'https://your-searxng.example.com/search?q={q}&format=json', header: '' },
    { value: 'brave', label: 'Brave Search API', sub: 'a third party receives every query', tpl: 'https://api.search.brave.com/res/v1/web/search?q={q}', header: 'X-Subscription-Token' },
    { value: 'custom', label: 'Something else', sub: 'any endpoint that answers with JSON' },
  ];
  function webPanel() {
    const s = H.settings.get();
    const endpoints = [
      ['LiteLLM proxy', s.baseUrl, 'all chat requests and model lists'],
      ...H.plugins.list().filter(p => p.enabled).map(p => [p.name + ' plugin', p.kind === 'mcp' ? p.url : p.baseUrl, 'only when its tools are called']),
      ...(s.corsProxy ? [['CORS proxy', s.corsProxy, 'web_fetch / web_search / plugin calls that fail directly (third party unless self-hosted)']] : []),
      ...(s.jinaFallback ? [['r.jina.ai', 'https://r.jina.ai', 'third-party reader: receives the URLs the model fetches']] : []),
      ...(s.searchTemplate ? [['Search provider', s.searchTemplate, 'receives search queries']] : []),
      ...(s.checkUpdates ? [['GitHub (update check)', H.ABOUT.versionUrl, 'a small version file fetched on startup and every hour; no data is sent']] : []),
      ['cdnjs.cloudflare.com', 'https://cdnjs.cloudflare.com', 'UI libraries (marked, DOMPurify, highlight.js) at startup, and pdf.js / JSZip / SheetJS only when you attach a PDF, Office or spreadsheet file; files are parsed locally, nothing is uploaded'],
      ['fonts.googleapis.com', 'https://fonts.googleapis.com', 'Instrument Sans, Instrument Serif and JetBrains Mono fonts loaded at startup; no data is sent'],
      ...(s.allowPyodideCdn ? [['Pyodide (jsDelivr)', s.pyodideUrl, 'downloaded only when Python is first used (code and data stay in the browser)']] : []),
    ];
    /* web search: pick who answers, then fill in only what that choice needs */
    const searchBox = el('div', { class: 'indent' });
    const guess = !s.searchTemplate ? 'off' : /searx/i.test(s.searchTemplate) ? 'searxng' : /brave/i.test(s.searchTemplate) ? 'brave' : 'custom';
    let preset = guess;
    const searchPick = picker({
      value: preset, title: 'Web search', search: false, options: SEARCH_PRESETS,
      onpick: (v) => {
        preset = v;
        const p = SEARCH_PRESETS.find(x => x.value === v);
        if (v === 'off') H.settings.set({ searchTemplate: '', searchKeyHeader: '' });
        else if (p.tpl && !H.settings.get('searchTemplate')) H.settings.set({ searchTemplate: p.tpl, searchKeyHeader: p.header || '' });
        paintSearch();
      },
    });
    function paintSearch() {
      searchBox.innerHTML = '';
      if (preset === 'off') { searchBox.append(el('p', { class: 'help' }, ['The model has no web_search tool. It can still read a page you give it a link to.'])); return; }
      searchBox.append(
        urlField('Search URL', 'searchTemplate', { id: false, placeholder: 'https://…/search?q={q}&format=json', help: '{q} is where the query goes. The endpoint has to answer with JSON and allow requests from this page.' }),
        field('API key header', 'searchKeyHeader', 'text', { placeholder: 'e.g. X-Subscription-Token — leave empty if the endpoint needs no key' }),
        secretField('API key value', () => H.settings.get('searchKeyValue') || '', (v) => H.settings.set({ searchKeyValue: v }), 'searchKeyValue', 'the token for that header'),
      );
    }
    paintSearch();
    return el('div', {}, [
      sec('Who this app talks to, right now', 'These hosts and no others. The list changes as you switch things on below — pages the model fetches are requested straight from your browser, not through anyone.', [
        el('table', { class: 'table net-table' }, [el('tbody', {}, endpoints.map(([n, u, w]) => el('tr', {}, [el('td', {}, [n]), el('td', { class: 'mono small' }, [u]), el('td', { class: 'small muted' }, [w])])))]),
      ]),
      sec('Web search', 'Searching needs someone to answer the query, and this app does not pick one for you — so web_search stays off until you name an endpoint.', [
        el('div', { class: 'field', id: 'set-searchTemplate' }, [el('span', {}, ['Search is answered by']), searchPick.el]),
        searchBox,
      ]),
      sec('Fetching pages', 'The browser fetches pages directly. A site that refuses cross-origin requests simply fails, and the model is told to offer you the link instead. Both options below hand the URL to somebody else.', [
        toggle('Use r.jina.ai when a page cannot be fetched', 'jinaFallback', null, {
          state: (v) => v ? 'Every URL the model cannot reach directly is sent to jina.ai, a third party, which fetches it instead.' : 'Nothing is sent to jina.ai. Pages that block the browser stay unread.',
        }),
        urlField('CORS proxy', 'corsProxy', { placeholder: 'https://proxy.example.com/?url={url}', empty: 'Not set — no proxy is used.', help: 'A proxy sees the whole request, credentials included, so only use one you or your company runs. {url} is where the target goes.' }),
      ]),
      sec('Updates', null, [
        toggle('Check GitHub for a newer version', 'checkUpdates', null, {
          state: (v) => v ? 'A public version file is fetched at startup and every hour. Nothing about you is sent with it.' : 'No update check. You will not hear about new versions.',
        }),
      ]),
      advanced([
        toggle('Download Pyodide when Python is first used', 'allowPyodideCdn', null, {
          state: (v) => v ? 'The Python runtime is fetched from the address below the first time run_python is called. Your code and data stay in the browser.' : 'run_python cannot start: the runtime is never downloaded.',
        }),
        urlField('Pyodide URL', 'pyodideUrl', { help: 'Point this at your own copy to keep the download in-house.' }),
      ], 'Advanced: Python runtime'),
    ]);
  }

  /* ---------- privacy & data ---------- */
  function privacyPanel() {
    return el('div', {}, [
      sec('Where your data lives', 'All of it stays in this browser profile. There is no server, no account, no analytics and no telemetry.', [el('table', { class: 'table' }, [el('tbody', {}, [
        ['Settings, tool policies, skills, plugin manifests', 'localStorage'], ['API key and plugin credentials', H.secrets.persist() ? 'localStorage (remembered)' : 'sessionStorage (this tab only)'], ['Chats, memories, usage counters', 'IndexedDB'], ['Workspace files', 'your local folder, reached through the File System Access API only after you pick it'],
      ].map(([a, b]) => el('tr', {}, [el('td', {}, [a]), el('td', { class: 'mono small' }, [b])])))])]),
      sec('Secrets', null, [
        toggle('Remember the API key and plugin credentials', 'persistSecrets', null, {
          get: () => H.secrets.persist(),
          set: (v) => { H.secrets.setPersist(v); H.toast(v ? 'Secrets are remembered on this device' : 'Secrets now live in this tab session only', 'success'); },
          state: (v) => v ? 'Kept on this device until you clear them, so you do not retype them every time.' : 'Cleared when this tab closes — you enter them again next time you open the app.',
        }),
        el('div', { class: 'row gap', style: 'margin-top:8px' }, [el('button', { class: 'btn sm danger-outline', onclick: () => { if (confirm('Forget the API key and all plugin credentials?')) { H.secrets.wipe(); H.toast('Secrets wiped', 'success'); settingsRepaint?.(); } } }, ['Forget all secrets'])]),
        el('p', { class: 'help', style: 'margin-top:10px' }, ['Exports never contain secrets. Anyone who can use this browser profile — or a malicious extension in it — can read what is stored, as with any web app.']),
      ]),
      sec('Backup', 'An export holds settings (without secrets), tool policies, plugins (without credentials), skills, chats and memories. It cannot hold the folders you have opened — a folder handle means nothing on another machine — or the file history kept for undo.', [
        el('div', { class: 'row gap wrap', id: 'set-export' }, [el('button', { class: 'btn', onclick: exportAll }, [H.icon('download'), 'Export everything']), el('button', { class: 'btn', onclick: importAll }, ['Import'])]),
      ]),
      sec('Running the model\'s code and showing its output', 'Everything the model produces is treated as untrusted: it runs walled off from this page and from your folder.', [advanced([el('ul', { class: 'help-list' }, [
        el('li', {}, ['JavaScript runs in a Web Worker with no DOM or workspace access; Python runs in Pyodide (WebAssembly) in a Worker. Both can make network requests, so run_* tools ask for permission by default. calculate, json_query and plugin expressions run in a Worker with all network APIs removed.']),
        el('li', {}, ['HTML previews render in a sandboxed iframe (unique origin) with an injected Content Security Policy: no fetch/XHR/WebSocket, no form posts, no remote images; scripts only inline or from the two CDNs the app itself uses.']),
        el('li', {}, ['Markdown from the model is sanitized with DOMPurify; images are shown as click-to-load placeholders so a reply can never trigger a request on its own.']),
        el('li', {}, ['web_fetch and http_request ask once per site (origin) in Default and Plan mode; "Allow this site for session" / "Always allow this site" remember the answer. A request routed through a connected browser tab (your login session) always asks, in every mode.']),
        el('li', {}, ['Tool output is treated as untrusted; the system prompt tells the model not to follow instructions embedded in fetched content. Review permission prompts for http_request and plugin write calls, which could exfiltrate data if the model is manipulated.']),
      ])], 'How exactly')]),
      sec('Danger zone', null, [el('div', { class: 'row gap wrap', id: 'set-wipe' }, [
        el('button', { class: 'btn danger-outline', onclick: async () => { if (confirm('Delete ALL chats, and the file history kept for them?')) { await H.db.clearChats(); await H.journal.clearAll(); H.agent.reset(); renderChatList(); } } }, ['Delete all chats']),
        el('button', { class: 'btn danger-outline', onclick: () => { if (confirm('Reset settings to defaults? (API key is kept)')) { H.settings.reset(); openSettings('general'); } } }, ['Reset settings']),
        el('button', { class: 'btn danger', onclick: async () => { if (confirm('Wipe EVERYTHING stored by this app in this browser (chats, settings, secrets, plugins, skills, the list of folders you have opened and the file history kept for undo)? Your folders themselves are not touched.')) { await H.db.clearChats(); H.secrets.wipe(); localStorage.clear(); sessionStorage.clear(); indexedDB.deleteDatabase('llm-harness'); location.reload(); } } }, ['Wipe all local data']),
      ])]),
    ]);
  }
  function aboutPanel() {
    const a = H.ABOUT;
    const beer = el('div', { class: 'note', style: 'color:var(--fg-2);background:var(--accent-soft)' }, [H.icon('beer'), ` No links, no donations: if this saved you time, buy ${a.author} a beer in person. 🍻`]);
    return el('div', {}, [
      el('div', { class: 'about-hero' }, [el('div', {}, [el('h3', {}, ['LLM Harness']), el('div', { class: 'muted small' }, [`Version ${a.version} · made by ${a.author}`])])]),
      sec('Updates', null, [el('div', { class: 'row gap wrap' }, [
        el('button', { class: 'btn', onclick: () => H.update.check({ manual: true }) }, [H.icon('refresh'), 'Check for updates']),
        el('a', { class: 'btn ghost', href: a.repoUrl, target: '_blank', rel: 'noopener' }, [H.icon('external'), 'GitHub repository']),
      ]), el('p', { class: 'help', style: 'margin-top:8px' }, ['Checks fetch a small version file from GitHub on startup and every hour; nothing else is sent. Turn it off in Web access. Updating = download the newer folder and replace this one; your data stays in the browser.'])]),
      sec('What it is', null, [el('p', { class: 'sec-desc', style: 'margin:0' }, ['A browser-only harness for LLMs: chats, tools, skills, plugins, plan mode and a browser-session bridge, talking straight to your LiteLLM proxy. No installation, no backend, nothing leaves your browser except the requests you configure.'])]),
      sec('Disclaimer', null, [el('div', { class: 'note' }, [`This software is provided "as is", without warranty of any kind. ${a.author} is not responsible for anything the assistant does with your accounts, files, tickets, repositories or systems, nor for any data loss, costs, or damage arising from its use. You are the operator: review permission prompts, use Plan mode for anything sensitive, and keep your credentials to yourself. Use at your own risk.`])]),
      sec('Found it useful?', null, [beer]),
      sec('License', null, [el('p', { class: 'sec-desc', style: 'margin:0' }, ['Open source under the MIT License: use, modify and redistribute freely, keep the copyright notice. ', el('a', { href: a.repoUrl + '/blob/main/LICENSE', target: '_blank', rel: 'noopener' }, ['Read the license'])])]),
    ]);
  }

  /* ---------------- import / export ---------------- */
  async function exportAll() {
    const data = { version: 2, exported: new Date().toISOString(), settings: { ...H.settings.get(), searchKeyValue: undefined }, perms: H.perms.rules(), plugins: JSON.parse(H.plugins.exportAll()), skills: H.skills.list(), chats: await H.db.allChats(), memory: await H.db.memAll() };
    H.download('harness-export.json', JSON.stringify(data, null, 2), 'application/json');
  }
  function importAll() {
    const i = el('input', { type: 'file', accept: '.json' });
    i.onchange = async () => {
      try {
        const d = JSON.parse(await H.readFileAsText(i.files[0]));
        if (d.settings) { delete d.settings.apiKey; H.settings.set(Object.fromEntries(Object.entries(d.settings).filter(([, v]) => v !== undefined))); }
        if (d.perms) for (const [k, v] of Object.entries(d.perms)) H.perms.setRule(k, v);
        if (d.plugins) for (const p of d.plugins) { const ex = H.plugins.get(p.id); H.plugins.upsert(ex ? { ...p, auth: ex.auth, headers: { ...(p.headers || {}), ...(ex.headers || {}) } } : p); }
        if (d.skills) for (const s of d.skills) H.skills.upsert(s);
        if (d.chats) for (const c of d.chats) await H.db.putChat(c);
        if (d.memory) for (const m of d.memory) await H.db.memSet(m.key, m.value, m.tags);
        renderChatList(); H.toast('Import complete', 'success');
      } catch (e) { H.toast('Import failed: ' + e.message, 'error'); }
    };
    i.click();
  }

  /* ---------------- preview panel ---------------- */
  /* Model HTML is shown inside preview.html (a same-origin host page with its own strict CSP) in a sandboxed frame.
     The host page announces itself with 'preview-ready'; the HTML is then handed over by postMessage. */
  const previewURL = () => 'preview.html?v=' + encodeURIComponent(window.APP_VERSION || '');
  const previewTarget = () => /^https?:\/\//.test(location.origin) ? location.origin : '*';   // file:// pages report "null" or "file://"
  const previewReady = new Map();   // Window -> Promise<void>
  function waitPreview(win) {
    if (previewReady.has(win)) return previewReady.get(win);
    const pr = new Promise((resolve) => {
      const on = (e) => { if (e.source === win && e.data && e.data.type === 'preview-ready') { removeEventListener('message', on); resolve(); } };
      addEventListener('message', on);
      setTimeout(() => { removeEventListener('message', on); resolve(); }, 8000);
    });
    previewReady.set(win, pr); return pr;
  }
  async function showPreview({ url, title, html, raw }) {
    const p = $('#preview'); p.classList.remove('hidden');
    p.querySelector('.ptitle').textContent = title; p.dataset.html = html; p.dataset.raw = raw ?? html;
    const fr = p.querySelector('iframe');
    if (!fr.getAttribute('src')) { fr.src = previewURL(); }
    await waitPreview(fr.contentWindow);
    fr.contentWindow.postMessage({ type: 'preview', title, html }, previewTarget());
  }
  function effectiveTheme() { const t = H.settings.get('theme'); return t === 'system' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : t; }
  function applyTheme() {
    const t = H.settings.get('theme');
    if (t === 'system') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', t);
    const eff = effectiveTheme();
    const d = $('#hljs-dark'), l = $('#hljs-light'); if (d) d.disabled = eff !== 'dark'; if (l) l.disabled = eff !== 'light';
  }
  try { matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => applyTheme()); } catch { }

  /* ---------------- init ---------------- */
  /* ---------------- accessibility: dialogs, labels, live announcements ---------------- */
  const announce = (text) => { const r = $('#sr-live'); if (!r) return; r.textContent = ''; setTimeout(() => { r.textContent = text; }, 30); };
  function a11yInit() {
    const labelButtons = (root) => root.querySelectorAll('button[title]:not([aria-label])').forEach(b => b.setAttribute('aria-label', b.title));
    labelButtons(document);
    const focusables = (el) => [...el.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')].filter(e => e.offsetParent !== null);
    const setupDialog = (ov) => {
      const box = ov.querySelector('.modal') || ov;
      box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.tabIndex = -1;
      const h = box.querySelector('h3'); if (h) { h.id ||= 'dlg-' + H.uid(); box.setAttribute('aria-labelledby', h.id); }
      ov._returnFocus = document.activeElement;
      const first = focusables(box).find(e => !e.classList.contains('bookmarklet')) || box;
      setTimeout(() => first.focus(), 20);
      ov.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { if (!ov.classList.contains('perm')) { e.stopPropagation(); ov.remove(); } return; }   // permission prompts need an explicit decision
        if (e.key !== 'Tab') return;
        const f = focusables(box); if (!f.length) return;
        const i = f.indexOf(document.activeElement);
        if (e.shiftKey && (i <= 0)) { e.preventDefault(); f[f.length - 1].focus(); }
        else if (!e.shiftKey && (i === f.length - 1 || i < 0)) { e.preventDefault(); f[0].focus(); }
      });
    };
    new MutationObserver((muts) => {
      for (const m of muts) {
        for (const n of m.addedNodes) { if (n.nodeType !== 1) continue; if (n.classList.contains('modal-overlay')) setupDialog(n); labelButtons(n); }
        for (const n of m.removedNodes) { if (n.nodeType !== 1 || !n.classList?.contains('modal-overlay')) continue; closeMenus();   /* a dropdown opened from the dialog must not outlive it */
          if (n._returnFocus && document.contains(n._returnFocus)) { try { n._returnFocus.focus(); } catch { } } }
      }
    }).observe(document.body, { childList: true, subtree: true });
    H.bus.on('run-state', (running, chatId) => { if (chatId === H.agent.current()?.id) announce(running ? 'Assistant is responding.' : 'Assistant finished.'); });
    H.bus.on('message-added', (m, chatId) => { if (chatId && chatId !== H.agent.current()?.id) return; if (m.role === 'tool') announce(`Running tool ${m.name}.`); });
    H.bus.on('message-updated', (m, chatId) => { if (chatId && chatId !== H.agent.current()?.id) return; if (m.role === 'assistant' && !m.meta?.streaming && m.content && !m._announced) { m._announced = true; announce('Assistant: ' + H.clamp(m.content, 800)); } if (m.role === 'tool' && m.meta?.question && m.meta.question.answered === undefined && !m._askAnnounced) { m._askAnnounced = true; announce('The assistant asks: ' + m.meta.question.text); } });
  }
  function init() {
    applyTheme(); a11yInit();
    const input = $('#input');
    input.addEventListener('input', () => { autoresize(); showSlash(); });
    input.addEventListener('keydown', (e) => {
      const menu = $('#slash-menu'); const open = !menu.classList.contains('hidden');
      if (open) {
        const items = slashItems() || [];
        if (e.key === 'ArrowDown') { e.preventDefault(); slashIdx = (slashIdx + 1) % items.length; showSlash(); return; }
        if (e.key === 'ArrowUp') { e.preventDefault(); slashIdx = (slashIdx - 1 + items.length) % items.length; showSlash(); return; }
        if (e.key === 'Tab' || e.key === 'Enter') { e.preventDefault(); pickSlash(items[Math.max(0, slashIdx)]); return; }
        if (e.key === 'Escape') { hideSlash(); return; }
      }
      const mode = H.settings.get('sendKey');
      const touch = window.matchMedia('(hover: none) and (pointer: coarse)').matches;   // phones/tablets: Enter makes a new line, the button sends
      if (e.key === 'Enter' && !touch && ((mode === 'enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) || (mode === 'ctrlenter' && (e.ctrlKey || e.metaKey)))) { e.preventDefault(); submit(); }
    });
    input.addEventListener('paste', (e) => { const files = [...(e.clipboardData?.files || [])]; if (files.length) { e.preventDefault(); addFiles(files); } });
    document.addEventListener('dragover', (e) => e.preventDefault());
    document.addEventListener('drop', (e) => { e.preventDefault(); if (e.dataTransfer?.files?.length) addFiles([...e.dataTransfer.files]); });
    $('#send-btn').onclick = submit;
    $('#stop-btn').onclick = () => H.agent.stop();
    $('#attach-btn').onclick = () => { const i = el('input', { type: 'file', multiple: true }); i.onchange = () => addFiles([...i.files]); i.click(); };
    $('#new-chat').onclick = () => H.agent.reset();
    $('#settings-btn').onclick = () => openSettings('general');
    for (const sel of ['#ctx-meter', '#usage']) {
      const t = $(sel);
      t.setAttribute('aria-haspopup', 'dialog'); t.setAttribute('aria-expanded', 'false');
      t.onclick = (e) => { e.stopPropagation(); toggleCtxPopup(t); };
      t.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleCtxPopup(t); } });
    }
    $('#sidebar-bug-btn').onclick = bugReport;
    const narrow = () => window.matchMedia('(max-width: 900px)').matches;
    const openDrawer = (on) => { $('#sidebar').classList.toggle('open', on); $('#backdrop').classList.toggle('hidden', !on); };
    $('#toggle-sidebar').onclick = () => { if (narrow()) openDrawer(!$('#sidebar').classList.contains('open')); else $('#sidebar').classList.toggle('collapsed'); };
    $('#backdrop').onclick = () => openDrawer(false);
    $('#chat-list').addEventListener('click', (e) => { if (narrow() && e.target.closest('.chat-item') && !e.target.closest('button')) openDrawer(false); });
    $('#new-chat').addEventListener('click', () => { if (narrow()) openDrawer(false); });
    window.addEventListener('resize', () => { if (!narrow()) openDrawer(false); });
    bindMenu($('#ws-btn'), $('#ws-menu'), renderWorkspaceMenu);
    bindMenu($('#more-btn'), $('#more-menu'));
    modelPick = picker({
      variant: 'pill', icon: 'cube', title: 'Model', search: true, searchPlaceholder: 'Filter models…',
      empty: 'No model matches', placeholder: 'No model', value: H.settings.get('model'),
      options: modelOptions(H.settings.get('models'), H.settings.get('model')),
      onpick: (v) => { H.settings.set({ model: v }); updateContextMeter(); },
    });
    modelPick.el.id = 'model-pick'; $('#model-pick').replaceWith(modelPick.el);
    modePick = picker({
      variant: 'pill', icon: 'shield', title: 'Chat mode', search: false, value: H.settings.get('chatMode'),
      options: MODES.map(m => ({ value: m.v, label: m.t, sub: m.short })),
      onpick: (v) => { H.settings.set({ chatMode: v }); updateModeUI(); },
    });
    modePick.el.id = 'mode-pick'; $('#mode-pick').replaceWith(modePick.el);
    document.addEventListener('click', () => closeMenus());
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && openMenus.size) { e.stopPropagation(); closeMenus(); } });
    $('#usage-btn').onclick = () => openSettings('usage');
    $('#changes-btn').onclick = () => changesPanel();
    H.bus.on('compacting', (id, on) => { if (id === H.agent.current()?.id && on) H.toast('Compacting the conversation…', 'info', 3000); });
    $('#bug-btn').onclick = bugReport;
    $('#chat-title').onclick = () => { const c = H.agent.current(); if (!c) return; const t = prompt('Chat title', c.title); if (t && t.trim()) { H.agent.rename(t.trim()).then(() => { updateTitle(); renderChatList(); }); } };
    $('#preview-close').onclick = () => $('#preview').classList.add('hidden');
    $('#preview-download').onclick = () => {   // the HTML as the model wrote it (without the injected preview policy)
      const p = $('#preview'); const html = p.dataset.raw || p.dataset.html || ''; if (!html) return H.toast('Nothing to download yet.', 'info');
      const name = ((p.querySelector('.ptitle').textContent || 'preview').replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'preview') + '.html';
      H.download(name, html, 'text/html'); H.toast(`Saved ${name}`, 'success');
    };
    $('#preview-open').onclick = async () => {   // never open model HTML on this origin: preview.html hosts it in a sandboxed frame with a strict CSP
      const html = $('#preview').dataset.html || ''; const title = $('#preview .ptitle').textContent || 'Preview';
      const w = window.open(previewURL(), '_blank'); if (!w) return H.toast('Popup blocked by the browser.', 'warn');
      await waitPreview(w);
      w.postMessage({ type: 'preview', title, html }, previewTarget());
    };
    $('#export-chat').onclick = () => { const c = H.agent.current(); if (!c) return; H.download((c.title || 'chat').replace(/[^\w-]+/g, '_') + '.md', H.chatMarkdown(c), 'text/markdown'); };
    $('#messages').addEventListener('scroll', () => { const b = $('#messages'); stick = b.scrollHeight - b.scrollTop - b.clientHeight < 80; updateScrollBtn(); });
    $('#scroll-bottom').onclick = () => { stick = true; scrollBottom(true); };
    $('#chat-search').addEventListener('input', () => renderChatList());
    updateModeUI(); updateTitle();

    let shownChatId = null;
    H.bus.on('chat-loaded', (c) => {
      if (shownChatId && shownChatId !== c.id) drafts.set(shownChatId, $('#input').value);   // keep the unsent text of the chat we leave
      shownChatId = c.id;
      renderChat(c); renderChatList(); updateTitle();
      $('#input').value = drafts.get(c.id) || ''; autoresize();
    });
    H.bus.on('chat-updated', () => { renderChatList(); updateTitle(); });
    H.bus.on('run-state', () => renderChatList());
    H.bus.on('message-added', onMessageAdded);
    H.bus.on('message-updated', onMessageUpdated);
    const syncRunButtons = () => { const r = H.agent.isRunning() && !H.agent.pendingQuestion(); $('#send-btn').classList.toggle('hidden', r); $('#stop-btn').classList.toggle('hidden', !r); updateModeUI(); };
    H.bus.on('run-state', () => { syncRunButtons(); renderChatList(); });
    H.bus.on('chat-loaded', () => { syncRunButtons(); updateModeUI(); });
    H.bus.on('usage', (c) => { if (!c || c === H.agent.current()) updateContextMeter(); });
    H.bus.on('mode', updateModeUI);
    H.bus.on('question', (chatId, q) => { if (chatId === H.agent.current()?.id) { updateModeUI(); syncRunButtons(); if (q) { $('#input').focus(); if (document.hidden) { try { if (Notification.permission === 'granted') new Notification('The assistant has a question', { body: q.question }); } catch { } } } } });
    H.bus.on('bridge', updateConnPill); H.bus.on('plugins', updateConnPill); H.bus.on('ext', updateConnPill); H.bus.on('settings', updateConnPill);
    setInterval(async () => { if (H.plugins.list().some(p => p.enabled && p.route?.type === 'bridge')) { await H.bridge.health(); } updateConnPill(); }, 20000);
    updateConnPill();
    $('#bridge-pill').onclick = async () => {
      await H.bridge.health(); updateConnPill();
      const broken = H.plugins.list().filter(p => p.enabled && pluginStatus(p).state === 'warn');
      const bridgeBroken = broken.find(p => (p.route?.type || 'direct') === 'bridge');
      if (bridgeBroken) return reconnect(bridgeBroken);          // one click = reconnect
      if (broken.length) return openSettings('plugins');
      H.toast('All plugins connected ✓', 'success', 2500);
    };
    H.bus.on('workspace', (n) => { updateWorkspaceBtn(n); if (!$('#ws-menu').classList.contains('hidden')) renderWorkspaceMenu(); });
    H.bus.on('git-state', () => updateWorkspaceBtn());
    H.bus.on('preview', showPreview);
    H.bus.on('settings', (s) => { if (modePick?.value !== s.chatMode) updateModeUI(); if (modelPick?.value !== s.model) setModelOptions(s.models || [], s.model); });
    H.bus.on('perm-prompt', () => { try { if (document.hidden && Notification.permission === 'granted') new Notification('Permission needed', { body: 'The assistant is waiting for your approval.' }); } catch { } });
  }

  return { init, renderChat, renderChatList, refreshModels, openSettings, setStatus, updateWorkspaceBtn, md, updateContextMeter, applyTheme };
})();
