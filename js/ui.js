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
      ['folder', 'Explore a workspace', 'Open a folder from the top bar, then ask the model to list and summarize the project.', 'List the files in the workspace and summarize what this project does.'],
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
    const chat = H.agent.current(); const model = H.settings.get('model');
    const est = H.usage.contextEstimate(chat);
    const p = H.usage.priceFor(model); const ctx = p.context || 128000;
    const pct = Math.min(100, Math.round(est / ctx * 100));
    const bar = $('#ctx-meter'); const circ = 2 * Math.PI * 15.5;
    bar.querySelector('.fg').style.strokeDasharray = `${circ * pct / 100} ${circ}`;
    bar.classList.toggle('warn', pct >= 70); bar.classList.toggle('danger', pct >= 90);
    bar.querySelector('.txt').textContent = `${pct}%` + (pct >= 90 ? ' context full' : pct >= 70 ? ' context' : '');
    const u = chat?.usage || { prompt: 0, completion: 0 };
    const cc = H.usage.chatCost(chat);
    const costTxt = H.settings.get('showCost') ? ' · ' + (cc.known ? H.usage.fmtCost(cc.cost) : 'set pricing') : '';
    $('#usage').textContent = `${H.usage.fmtTok((u.prompt || 0) + (u.completion || 0))} tok${costTxt}`;
    bar.title = `Context window: ~${est.toLocaleString()} of ${ctx.toLocaleString()} tokens used (${pct}%)${pct >= 70 ? '\nThe older part will be compacted automatically before the next message (⋯ menu → Compact this chat to do it now).' : ''}\nChat total: ${(u.prompt || 0).toLocaleString()} in / ${(u.completion || 0).toLocaleString()} out` + (cc.known ? `\nCost: ${H.usage.fmtCost(cc.cost)}${cc.partial ? ' (some messages have no pricing)' : ''}` : '\nCost unknown: set pricing in Settings > Usage & costs');
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
    if (H.agent.pendingQuestion()) { H.agent.answerQuestion(H.agent.current().id, text); t.value = ''; autoresize(); return; }   // answer, not a new message
    if (H.agent.isRunning()) return;
    if (!H.settings.apiKey() && !confirm('No API key configured. Send anyway?')) { openSettings('connection'); return; }
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
  function slashItems() { const v = $('#input').value; const m = v.match(/^\/([a-z0-9_-]*)$/i); if (!m) return null; return H.skills.list().filter(s => s.name.startsWith(m[1].toLowerCase())); }
  function showSlash() {
    const items = slashItems(); const menu = $('#slash-menu');
    if (!items || !items.length) { hideSlash(); return; }
    menu.classList.remove('hidden'); menu.innerHTML = '';
    if (slashIdx >= items.length || slashIdx < 0) slashIdx = 0;
    items.forEach((s, i) => menu.append(el('div', { class: 'item' + (i === slashIdx ? ' active' : ''), onmousedown: (e) => { e.preventDefault(); pickSlash(s); } }, [el('b', {}, ['/' + s.name]), el('span', { class: 'muted small' }, [s.description])])));
  }
  function hideSlash() { $('#slash-menu').classList.add('hidden'); slashIdx = -1; }
  function pickSlash(s) { $('#input').value = '/' + s.name + ' '; hideSlash(); $('#input').focus(); }

  /* ---------------- topbar ---------------- */
  function fillModelSelect(sel, models, cur) {
    sel.innerHTML = '';
    if (cur && !models.includes(cur)) sel.append(el('option', { value: cur }, [cur + (models.length ? ' (not in list)' : '')]));
    if (!models.length && !cur) sel.append(el('option', { value: '' }, ['No models loaded']));
    models.forEach(m => sel.append(el('option', { value: m, selected: m === cur }, [m])));
  }
  async function refreshModels() {
    const sel = $('#model-select'); const cur = H.settings.get('model');
    fillModelSelect(sel, H.settings.get('models') || [], cur);
    try {
      const models = await H.llm.listModels();
      const patch = { models }; if (!cur && models.length) patch.model = models[0];
      H.settings.set(patch);
      fillModelSelect(sel, models, patch.model || cur);
      setStatus('online', `${models.length} models`);
      H.usage.refreshModelInfo().then(updateContextMeter);
      return models;
    } catch (e) { setStatus('error', 'LiteLLM unreachable'); console.warn(e); throw e; }
  }
  function setStatus(kind, text) { const s = $('#status'); s.className = kind; s.querySelector('.txt').textContent = text; }
  /* "folder · branch ●3" — the branch comes from .git/HEAD (one small read); the change count only
     appears once something has actually run git_status, it is never computed to paint a button. */
  function updateWorkspaceBtn(name) {
    const n = (name === undefined ? H.fs.name() : name) || '';
    const btn = $('#ws-btn');
    btn.querySelector('.lbl').textContent = n || 'Workspace';
    btn.classList.toggle('primary', !!n);
    const g = n ? H.git.state() : null;
    let tag = btn.querySelector('.ws-git');
    if (g?.branch) {
      if (!tag) { tag = el('span', { class: 'ws-git' }); btn.append(tag); }
      const dirty = (g.dirty || 0) + (g.untracked || 0);
      tag.textContent = '· ' + g.branch + (dirty ? ' ●' + dirty : '');
      btn.title = `${n} — git branch ${g.branch}` + (g.dirty != null ? `, ${g.dirty} changed and ${g.untracked} untracked file(s) at the last git_status` : '');
    } else { tag?.remove(); btn.title = n ? `Workspace folder: ${n}` : 'Open a local folder as the workspace for file tools'; }
  }
  function updateModeUI() {
    const mode = H.perms.effectiveMode(); const sel = $('#mode-select'); sel.value = H.settings.get('chatMode');
    document.body.dataset.mode = mode;
    if (H.agent.pendingQuestion()) { $('#input').placeholder = 'Answer the assistant\'s question…'; $('#send-btn').classList.remove('hidden'); $('#stop-btn').classList.add('hidden'); document.body.classList.add('asking'); return; }
    document.body.classList.remove('asking');
    $('#mode-wrap').title = { default: 'Default: read-only tools run, writes ask you first', auto: 'Allow all: every tool runs without asking', plan: 'Plan: read-only investigation, then a plan you can execute' }[mode] || 'Chat mode';
    $('#input').placeholder = mode === 'plan' ? 'Plan mode: describe what you want planned…' : window.matchMedia('(max-width: 560px)').matches ? 'Message…' : 'Message… type / for skills, drop files to attach';
  }
  function updateTitle() { const c = H.agent.current(); $('#chat-title').textContent = c?.title || 'New chat'; }
  function bugReport() {
    const s = H.settings.get(); const c = H.agent.current();
    const body = `**What happened**\n\n\n**What I expected**\n\n\n**Steps to reproduce**\n1.\n\n---\nVersion: ${H.ABOUT.version} · Browser: ${navigator.userAgent} · Origin: ${/^https?:/.test(location.origin) ? location.origin : 'file://'} · Mode: ${s.chatMode} · Model: ${s.model || '-'} · Plugins enabled: ${H.plugins.list().filter(p => p.enabled).map(p => p.id).join(', ') || 'none'} · Bridges: ${H.bridge.list().length}${c?.messages.length ? ` · Last tool error: ${(c.messages.filter(m => m.role === 'tool' && m.meta?.error).at(-1)?.meta.error || '-').slice(0, 200)}` : ''}`;
    window.open(`${H.ABOUT.repoUrl}/issues/new?title=${encodeURIComponent('Bug: ')}&body=${encodeURIComponent(body)}`, '_blank', 'noopener');
  }

  /* ================= SETTINGS ================= */
  let settingsModal = null;
  const SECTIONS = [
    ['connection', 'Connection', 'link'], ['model', 'Model & generation', 'cube'], ['modes', 'Chat modes & permissions', 'shield'], ['tools', 'Tools', 'tool'],
    ['plugins', 'Plugins', 'plug'], ['skills', 'Skills', 'bolt'], ['usage', 'Usage & costs', 'chart'], ['security', 'Security & privacy', 'lock'], ['data', 'Data', 'db'], ['about', 'About', 'beer'],
  ];
  function openSettings(section = 'connection') {
    if (settingsModal) settingsModal.remove();
    const nav = el('nav', { class: 'settings-nav' });
    const body = el('div', { class: 'settings-body' });
    const builders = { connection: connectionPanel, model: modelPanel, modes: modesPanel, tools: toolsPanel, plugins: pluginsPanel, skills: skillsPanel, usage: usagePanel, security: securityPanel, data: dataPanel, about: aboutPanel };
    const show = (k) => { nav.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.k === k)); body.innerHTML = ''; body.append(builders[k]()); body.scrollTop = 0; };
    for (const [k, label, ic] of SECTIONS) nav.append(el('button', { 'data-k': k, onclick: () => show(k) }, [H.icon(ic), label]));
    settingsModal = el('div', { class: 'modal-overlay', onclick: (e) => { if (e.target === settingsModal) close(); } }, [el('div', { class: 'modal settings' }, [
      el('div', { class: 'modal-head' }, [el('h3', {}, ['Settings']), el('span', { class: 'spacer' }), el('button', { class: 'btn icon ghost', onclick: close }, [H.icon('x')])]),
      el('div', { class: 'settings-layout' }, [nav, body])])]);
    document.body.append(settingsModal); show(section);
    function close() { settingsModal.remove(); settingsModal = null; updateModeUI(); updateContextMeter(); }
  }
  const sec = (title, desc, children) => el('section', { class: 'sec' }, [el('h4', {}, [title]), desc ? el('p', { class: 'sec-desc' }, [desc]) : null, ...[].concat(children)]);
  const field = (label, key, type = 'text', extra = {}) => { const s = H.settings.get(); return el('label', { class: 'field' }, [el('span', {}, [label]), el('input', { type, value: s[key] ?? '', ...extra, onchange: (e) => H.settings.set({ [key]: type === 'number' ? +e.target.value : e.target.value }) })]); };
  const check = (label, key, help) => { const s = H.settings.get(); return el('label', { class: 'check' }, [el('input', { type: 'checkbox', checked: !!s[key], onchange: (e) => H.settings.set({ [key]: e.target.checked }) }), el('span', {}, [label, help ? el('span', { class: 'help' }, [help]) : null])]); };
  const selectField = (label, key, options, onchange) => { const s = H.settings.get(); return el('label', { class: 'field' }, [el('span', {}, [label]), el('select', { onchange: (e) => { H.settings.set({ [key]: e.target.value }); onchange && onchange(e.target.value); } }, options.map(([v, l]) => el('option', { value: v, selected: s[key] === v }, [l])))]); };

  function connectionPanel() {
    const status = el('span', { class: 'small muted' });
    const keyInput = el('input', { type: 'password', value: H.settings.apiKey(), placeholder: 'sk-…', autocomplete: 'off', onchange: (e) => H.settings.setApiKey(e.target.value.trim()) });
    return el('div', {}, [
      sec('LiteLLM proxy', 'The app talks to your LiteLLM proxy directly from this browser tab. Nothing else sits in between.', [
        field('Base URL', 'baseUrl', 'url', { placeholder: 'https://litellm.example.com' }),
        el('p', { class: 'help' }, ['Root of the proxy, without /v1. The proxy must allow this page\'s origin (LiteLLM allows all origins by default).']),
        el('label', { class: 'field' }, [el('span', {}, ['API key']), keyInput]),
        el('p', { class: 'help' }, [H.secrets.persist() ? 'Stored on this device (browser storage). Change in Security & privacy to keep it only for this session.' : 'Kept for this browser session only (Security & privacy).']),
        el('div', { class: 'row gap' }, [el('button', { class: 'btn primary', onclick: async () => { status.textContent = 'Connecting…'; try { const m = await refreshModels(); status.textContent = `Connected · ${m.length} models available`; } catch (e) { status.textContent = 'Failed: ' + e.message; } } }, ['Test connection']), status]),
      ]),
      sec('Interface', null, [
        selectField('Send message with', 'sendKey', [['enter', 'Enter (Shift+Enter for a new line)'], ['ctrlenter', 'Ctrl / Cmd + Enter']]),
        selectField('Theme', 'theme', [['system', 'Follow system'], ['dark', 'Dark'], ['light', 'Light']], applyTheme),
        el('div', { class: 'check-list' }, [check('Stream responses', 'streaming', 'show the reply while it is being generated'), check('Auto-title new chats', 'autoTitle', 'uses one extra small request per chat')]),
      ]),
    ]);
  }
  function modelPanel() {
    const s = H.settings.get();
    const sel = el('select', { onchange: (e) => { H.settings.set({ model: e.target.value }); $('#model-select').value = e.target.value; info(); } });
    fillModelSelect(sel, s.models || [], s.model);
    const infoBox = el('div', { class: 'kv-card' });
    const info = () => { const m = H.settings.get('model'); const p = H.usage.priceFor(m); const mi = H.settings.get('modelInfo')?.[m]; infoBox.innerHTML = ''; infoBox.append(el('div', { class: 'kv' }, [
      el('span', {}, ['Context window']), el('b', {}, [p.context ? p.context.toLocaleString() + ' tokens' : 'unknown']),
      el('span', {}, ['Input price']), el('b', {}, [p.inPerTok != null ? '$' + (p.inPerTok * 1e6).toFixed(2) + ' / 1M' + (p.cachedPerTok != null ? ` (cached: $${(p.cachedPerTok * 1e6).toFixed(2)})` : '') : 'unknown']),
      el('span', {}, ['Output price']), el('b', {}, [p.outPerTok != null ? '$' + (p.outPerTok * 1e6).toFixed(2) + ' / 1M' : 'unknown']),
      el('span', {}, ['Source']), el('b', {}, [p.source === 'litellm' ? 'LiteLLM /model/info' : p.source === 'manual' ? 'manual override' : 'not available' + (mi?.provider ? ' · ' + mi.provider : '')]),
    ])); };
    info();
    const custom = el('input', { type: 'text', placeholder: 'Model name not in the list (advanced)', onchange: (e) => { if (e.target.value.trim()) { H.settings.set({ model: e.target.value.trim() }); fillModelSelect(sel, H.settings.get('models'), e.target.value.trim()); fillModelSelect($('#model-select'), H.settings.get('models'), e.target.value.trim()); info(); e.target.value = ''; } } });
    return el('div', {}, [
      sec('Default model', 'Models come from your LiteLLM proxy. Refresh after adding models to the proxy.', [
        el('div', { class: 'row gap' }, [sel, el('button', { class: 'btn', onclick: async () => { try { const m = await refreshModels(); fillModelSelect(sel, m, H.settings.get('model')); info(); H.toast(`${m.length} models loaded`, 'success'); } catch (e) { H.toast(e.message, 'error'); } } }, [H.icon('refresh'), 'Refresh'])]),
        infoBox, custom,
      ]),
      sec('Generation', null, [
        el('div', { class: 'row gap' }, [field('Temperature', 'temperature', 'number', { step: 0.1, min: 0, max: 2 }), field('Max output tokens', 'maxTokens', 'number', { step: 1 }), field('Max tool calls per turn', 'maxToolIterations', 'number', { step: 1 })]),
        el('label', { class: 'field' }, [el('span', {}, ['Custom system prompt (prepended to the built-in one)']), el('textarea', { rows: 5, onchange: (e) => H.settings.set({ systemPrompt: e.target.value }) }, [s.systemPrompt])]),
      ]),
      sec('Context management', 'Keeps long chats within the model\'s window and keeps costs linear.', [
        el('div', { class: 'check-list' }, [check('Compact automatically', 'autoCompact', 'when the context passes the threshold, the older part of the chat is summarised by the model and replaced by that summary; the last turns stay verbatim')]),
        el('div', { class: 'row gap' }, [field('Compact when context is above (0.5–0.95)', 'compactAt', 'number', { step: 0.05, min: 0.3, max: 0.95 }), field('Keep the last N user turns verbatim', 'compactKeepTurns', 'number', { step: 1, min: 1 })]),
        el('div', { class: 'row gap' }, [field('Send full tool results for the last N turns', 'keepToolTurns', 'number', { step: 1, min: 0 }), field('Older tool results are cut to (chars)', 'toolStubChars', 'number', { step: 40, min: 80 })]),
        el('p', { class: 'help' }, ['Older tool outputs become short stubs the model can re-fetch by calling the tool again. Compaction can also be run by hand from the ⋯ menu.']),
      ]),
      sec('Media', 'Images are resized in the browser before sending. Videos are turned into a few sampled frames plus a transcript; audio into a transcript. Transcription needs a speech-to-text model on your proxy.', [
        el('div', { class: 'row gap' }, [field('Transcription model (empty = off)', 'transcriptionModel', 'text', { placeholder: 'whisper-1' }), el('button', { class: 'btn', style: 'margin-top:9px', onclick: () => { const w = (H.settings.get('models') || []).filter(m => /whisper|transcri|speech|stt/i.test(m)); H.toast(w.length ? 'Speech models on your proxy: ' + w.join(', ') : 'No obvious speech-to-text model in the model list; ask your LiteLLM admin.', w.length ? 'success' : 'warn', 8000); } }, ['Find'])]),
        el('p', { class: 'help' }, ['Vision (images, video frames) requires a multimodal chat model; otherwise the proxy rejects the request with an error you will see in the chat.']),
      ]),
    ]);
  }
  function modesPanel() {
    const modes = [
      ['default', 'Default', 'Safe, read-only tools run automatically. Anything that writes, executes or sends data asks you first.'],
      ['auto', 'Allow all', 'Every tool runs without asking (except tools you explicitly denied). Fastest, least safe.'],
      ['plan', 'Plan', 'The model can only read and investigate. It produces a numbered plan; you then choose to execute it with the permissions you want.'],
    ];
    const cur = H.settings.get('chatMode');
    return el('div', {}, [
      sec('Chat mode', 'Also switchable from the top bar. The mode applies to new tool calls immediately.', [
        el('div', { class: 'mode-cards' }, modes.map(([v, t, d]) => el('label', { class: 'mode-card' + (cur === v ? ' active' : '') }, [el('input', { type: 'radio', name: 'mode', value: v, checked: cur === v, onchange: () => { H.settings.set({ chatMode: v }); updateModeUI(); openSettings('modes'); } }), el('b', {}, [t]), el('span', { class: 'small muted' }, [d])]))),
        selectField('When executing a plan, use', 'planExecuteMode', [['default', 'Default permissions (ask for writes)'], ['auto', 'Allow all (no prompts)']]),
        check('Always ask, even for safe tools', 'alwaysAsk', 'strict mode; applies to Default and Plan'),
      ]),
      sec('How permissions work', null, [el('ul', { class: 'help-list' }, [
        el('li', {}, [el('span', { class: 'chip risk-safe' }, ['safe']), ' read-only tools (list, read, search, fetch). Auto-allowed in Default mode.']),
        el('li', {}, [el('span', { class: 'chip risk-write' }, ['write']), ' tools that change files, run code, send requests or copy to your clipboard. Ask by default.']),
        el('li', {}, [el('span', { class: 'chip risk-danger' }, ['danger']), ' destructive tools (delete, merge). Ask by default; consider denying.']),
        el('li', {}, ['Per-tool overrides (allow / ask / deny) live in the Tools section. "Deny" always wins, in every mode.']),
      ])]),
    ]);
  }
  function toolsPanel() {
    const s = H.settings.get();
    const wrap = el('div', {});
    const groups = H.tools.groups();
    const disabled = new Set(s.disabledTools || []);
    const total = Object.values(groups).flat().length;
    const filter = el('input', { type: 'text', placeholder: `Filter ${total} tools…`, oninput: () => { const q = filter.value.toLowerCase(); wrap.querySelectorAll('.tool-row').forEach(r => r.classList.toggle('hidden', !!q && !r.dataset.k.includes(q))); wrap.querySelectorAll('.group-title').forEach(g => { let n = g.nextElementSibling, any = false; while (n && n.classList.contains('tool-row')) { if (!n.classList.contains('hidden')) any = true; n = n.nextElementSibling; } g.classList.toggle('hidden', !any); }); } });
    const bulk = (fn) => { for (const t of Object.values(groups).flat()) fn(t); openSettings('tools'); };
    wrap.append(sec('Tools', 'Enabled controls whether the model can see a tool. Policy overrides the chat mode for that tool: allow (silent), ask, deny.', [
      el('div', { class: 'row gap wrap toolbar' }, [filter,
        el('button', { class: 'btn sm', onclick: () => bulk(t => { if (t.risk === 'safe' && !t.scope) H.perms.setRule(t.name, 'allow'); }) }, ['Allow all safe']),
        el('button', { class: 'btn sm', onclick: () => bulk(t => H.perms.setRule(t.name, 'default')) }, ['Reset policies']),
        el('button', { class: 'btn sm', onclick: () => { H.settings.set({ disabledTools: [] }); openSettings('tools'); } }, ['Enable all']),
        el('button', { class: 'btn sm', onclick: () => { H.perms.clearSession(); H.toast('Session grants cleared'); } }, ['Clear session grants'])]),
    ]));
    const siteRules = Object.entries(H.perms.rules()).filter(([k]) => k.includes('@'));
    wrap.append(sec('Site rules', 'web_fetch and http_request ask once per site. Answers you chose to keep ("Always" / "Never allow this site") are listed here.', [
      siteRules.length ? el('table', { class: 'table' }, [el('tbody', {}, siteRules.map(([k, v]) => { const [tool, origin] = [k.slice(0, k.indexOf('@')), k.slice(k.indexOf('@') + 1)]; return el('tr', {}, [el('td', { class: 'mono small' }, [tool]), el('td', { class: 'mono small' }, [origin]), el('td', {}, [el('span', { class: 'chip ' + (v === 'allow' ? 'ok' : 'danger') }, [v])]), el('td', {}, [el('button', { class: 'btn sm ghost', onclick: () => { H.perms.setRule(k, 'default'); openSettings('tools'); } }, ['Remove'])])]); }))])
        : el('p', { class: 'help' }, ['No site rules yet. Session-only grants are cleared when you start a new chat or reload.']),
    ]));
    for (const [g, tools] of Object.entries(groups)) {
      wrap.append(el('div', { class: 'group-title' }, [g, el('span', { class: 'count' }, [String(tools.length)])]));
      for (const t of tools) {
        const rule = H.perms.rules()[t.name] || 'default';
        wrap.append(el('div', { class: 'tool-row', 'data-k': (t.name + ' ' + t.description + ' ' + g).toLowerCase() }, [
          el('div', {}, [el('div', { class: 'row gap' }, [el('code', {}, [t.name]), el('span', { class: 'chip risk-' + t.risk }, [t.risk]), t.rerun ? el('span', { class: 'chip', title: 'You can re-run this tool from its card in the chat' }, ['re-runnable']) : null]), el('div', { class: 'desc' }, [t.description])]),
          el('label', { class: 'check small' }, [el('input', { type: 'checkbox', checked: !disabled.has(t.name), onchange: (e) => { const d = new Set(H.settings.get('disabledTools')); e.target.checked ? d.delete(t.name) : d.add(t.name); H.settings.set({ disabledTools: [...d] }); } }), 'enabled']),
          el('select', { onchange: (e) => H.perms.setRule(t.name, e.target.value) }, [
            el('option', { value: 'default', selected: rule === 'default' }, [`mode default (${H.perms.defaultFor(t)})`]),
            el('option', { value: 'allow', selected: rule === 'allow' }, ['always allow']), el('option', { value: 'ask', selected: rule === 'ask' }, ['always ask']), el('option', { value: 'deny', selected: rule === 'deny' }, ['deny'])]),
        ]));
      }
    }
    return wrap;
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
        el('select', { onchange: (e) => { if (!e.target.value) return; H.plugins.upsert(H.deepClone(H.plugins.templates[e.target.value])); render(); } }, [el('option', { value: '' }, ['Re-add template…']), el('option', { value: 'jira' }, ['Jira Cloud (API v3)']), el('option', { value: 'jira2' }, ['Jira Server / DC (API v2)']), el('option', { value: 'git' }, ['GitHub']), el('option', { value: 'gitlab' }, ['GitLab']), el('option', { value: 'litellmMcp' }, ['LiteLLM MCP gateway'])]),
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
    const authSel = el('select', {}, setup.auth.map((a, i) => el('option', { value: i, selected: p.auth?.type === a.type }, [a.label])));
    const credBox = el('div', {});
    const result = el('div', { class: 'setup-result hidden' });
    let curAuth = setup.auth.find(a => a.type === p.auth?.type) || setup.auth[0];
    const renderCreds = () => {
      curAuth = setup.auth[+authSel.value] || setup.auth[0]; credBox.innerHTML = '';
      if (curAuth.help || curAuth.link) credBox.append(el('p', { class: 'help' }, [curAuth.help || '', ' ', curAuth.link ? el('a', { href: curAuth.link.replace('{{baseUrl}}', url.value.replace(/\/+$/, '')), target: '_blank', rel: 'noopener' }, ['Open token page ', H.icon('external')]) : null]));
      for (const f of curAuth.fields) {
        const existing = p.kind === 'mcp' ? (p.headers?.Authorization || '') : (p.auth?.[f.key] || '');
        credBox.append(el('label', { class: 'field' }, [el('span', {}, [f.label]), el('input', { type: f.secret ? 'password' : 'text', 'data-key': f.key, value: /^<.*>$/.test(existing) ? '' : existing, autocomplete: 'off' })]));
      }
    };
    authSel.onchange = renderCreds; renderCreds();
    /* connection route */
    const route = p.route || { type: 'direct' };
    const litellmBase = H.settings.get('baseUrl').replace(/\/+$/, '');
    const rPath = el('input', { type: 'text', value: route.path || p.id, placeholder: p.id });
    const rProxy = el('input', { type: 'url', value: route.proxyUrl || '', placeholder: 'https://proxy.example.com/?url={url}' });
    const snippet = el('pre', { class: 'perm-args small' });
    const routeDetail = el('div', {});
    const routeSel = el('select', {}, [
      el('option', { value: 'bridge', selected: route.type === 'bridge' }, ['Browser session bridge (bookmarklet in a logged-in tab) — recommended']),
      el('option', { value: 'direct', selected: route.type === 'direct' }, ['Direct from the browser (only if the API allows CORS)']),
      el('option', { value: 'extension', selected: route.type === 'extension' }, [`Connector extension${H.ext.available() ? ' (installed ✓)' : ' (only if you may load extensions)'}`]),
      el('option', { value: 'litellm', selected: route.type === 'litellm' }, ['Through a LiteLLM pass-through endpoint (needs proxy admin)']),
      el('option', { value: 'proxy', selected: route.type === 'proxy' }, ['Through a CORS proxy URL I trust']),
    ]);
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
    routeSel.onchange = renderRoute; rPath.oninput = renderRoute; url.addEventListener('input', renderRoute);
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
      el('div', { class: 'step' }, [el('div', { class: 'step-n' }, ['2']), el('div', { class: 'step-body' }, [el('label', { class: 'field' }, [el('span', {}, ['Authentication']), authSel]), credBox, el('p', { class: 'help' }, ['Credentials are stored as a secret in this browser only and sent solely to the URL above.'])])]),
      el('div', { class: 'step' }, [el('div', { class: 'step-n' }, ['3']), el('div', { class: 'step-body' }, [el('label', { class: 'field' }, [el('span', {}, ['Connection route']), routeSel]), routeDetail])]),
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
      wrap.append(sec('Skills', 'Reusable instruction sets. Type /name in the chat, or let the model load one via use_skill when a request matches its description.', []));
      for (const s of H.skills.list()) {
        wrap.append(el('div', { class: 'card' }, [
          el('div', { class: 'row gap' }, [el('h4', {}, ['/' + s.name]), el('span', { class: 'spacer' }),
            el('button', { class: 'btn sm', onclick: () => skillEditor(s, render) }, ['Edit']),
            el('button', { class: 'btn sm ghost', onclick: () => H.download(s.name + '.md', H.skills.serialize(s), 'text/markdown') }, ['Export']),
            el('button', { class: 'btn sm danger-outline', onclick: () => { if (confirm('Delete skill ' + s.name + '?')) { H.skills.remove(s.name); render(); } } }, ['Delete'])]),
          el('div', { class: 'small muted' }, [s.description]),
        ]));
      }
      wrap.append(el('div', { class: 'row gap wrap', style: 'margin-top:12px' }, [
        el('button', { class: 'btn', onclick: () => skillEditor({ name: '', description: '', content: '' }, render) }, [H.icon('plus'), 'New skill']),
        el('button', { class: 'btn', onclick: () => { const i = el('input', { type: 'file', accept: '.md,.txt', multiple: true }); i.onchange = async () => { for (const f of i.files) H.skills.upsert(H.skills.parse(await H.readFileAsText(f), f.name.replace(/\.\w+$/, ''))); render(); }; i.click(); } }, ['Import .md']),
        el('button', { class: 'btn ghost', onclick: () => { H.skills.resetBuiltin(); render(); } }, ['Restore built-in skills']),
      ]));
    };
    render(); return wrap;
  }
  function skillEditor(s, done) {
    const orig = s.name; s = H.deepClone(s);
    const ov = el('div', { class: 'modal-overlay' });
    const name = el('input', { type: 'text', value: s.name, placeholder: 'kebab-case-name' }), desc = el('input', { type: 'text', value: s.description, placeholder: 'One-line description (shown to the model)' }), body = el('textarea', { rows: 14, class: 'mono' }, [s.content]);
    ov.append(el('div', { class: 'modal wide' }, [el('h3', {}, [orig ? 'Edit skill' : 'New skill']),
      el('label', { class: 'field' }, [el('span', {}, ['Name']), name]), el('label', { class: 'field' }, [el('span', {}, ['Description']), desc]), el('label', { class: 'field' }, [el('span', {}, ['Instructions (markdown)']), body]),
      el('div', { class: 'row gap' }, [el('button', { class: 'btn primary', onclick: () => { const n = name.value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-'); if (!n) return; if (orig && orig !== n) H.skills.remove(orig); H.skills.upsert({ name: n, description: desc.value.trim(), content: body.value }); ov.remove(); done(); } }, ['Save']), el('button', { class: 'btn', onclick: () => ov.remove() }, ['Cancel'])])]));
    document.body.append(ov);
  }

  /* ---------- usage ---------- */
  function usagePanel() {
    const wrap = el('div', {});
    const stat = (label, value, sub) => el('div', { class: 'stat' }, [el('div', { class: 'stat-v' }, [value]), el('div', { class: 'stat-l' }, [label]), sub ? el('div', { class: 'stat-s' }, [sub]) : null]);
    const chat = H.agent.current(); const u = chat?.usage || { prompt: 0, completion: 0, requests: 0 };
    const model = H.settings.get('model'); const p = H.usage.priceFor(model);
    const est = H.usage.contextEstimate(chat); const cc = H.usage.chatCost(chat);
    wrap.append(sec('Current chat', null, [el('div', { class: 'stats' }, [
      stat('Context in use', `${H.usage.fmtTok(est)}`, `of ${H.usage.fmtTok(p.context)} (${Math.round(est / p.context * 100)}%)`),
      stat('Input tokens', H.usage.fmtTok(u.prompt || 0)), stat('Output tokens', H.usage.fmtTok(u.completion || 0)),
      stat('Cost', cc.known ? H.usage.fmtCost(cc.cost) : 'set pricing', `${u.requests || 0} requests${cc.partial ? ' · partly unpriced' : ''}`),
    ])]));
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
      totalBox.append(el('div', { class: 'row gap', style: 'margin-top:10px' }, [el('button', { class: 'btn sm danger-outline', onclick: async () => { if (confirm('Reset all-time usage counters?')) { await H.usage.resetTotal(); openSettings('usage'); } } }, ['Reset counters'])]));
    })();
    const pricing = H.settings.get('pricing') || {};
    const pr = el('textarea', { rows: 5, class: 'mono', placeholder: '{ "gpt-4o": { "in": 2.5, "out": 10, "cached": 1.25, "context": 128000 } }', onchange: (e) => { try { H.settings.set({ pricing: e.target.value.trim() ? JSON.parse(e.target.value) : {} }); H.toast('Pricing saved', 'success'); updateContextMeter(); } catch (err) { H.toast('Invalid JSON: ' + err.message, 'error'); } } }, [Object.keys(pricing).length ? JSON.stringify(pricing, null, 2) : '']);
    wrap.append(sec('Pricing & context windows', `Prices are read from LiteLLM's /model/info when available (current model: ${p.source === 'litellm' ? 'found' : p.source === 'manual' ? 'manual' : 'not found'}). Override or add models here as USD per 1M tokens.`, [pr, el('div', { class: 'row gap' }, [field('Fallback context window (tokens)', 'defaultContext', 'number', { step: 1000 }), el('button', { class: 'btn', style: 'margin-top:9px', onclick: async () => { const i = await H.usage.refreshModelInfo(); H.toast(i ? `Model info loaded for ${Object.keys(i).length} models` : 'No /model/info endpoint available', i ? 'success' : 'warn'); openSettings('usage'); } }, ['Refresh from LiteLLM'])]), check('Show cost in the top bar and messages', 'showCost')]));
    return wrap;
  }

  /* ---------- security ---------- */
  function securityPanel() {
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
    const persistToggle = el('input', { type: 'checkbox', checked: H.secrets.persist(), onchange: (e) => { H.secrets.setPersist(e.target.checked); H.toast(e.target.checked ? 'Secrets are remembered on this device' : 'Secrets now live in this tab session only', 'success'); } });
    return el('div', {}, [
      sec('Where your data lives', 'Everything stays in this browser profile. There is no server component, no analytics, no telemetry.', [el('table', { class: 'table' }, [el('tbody', {}, [
        ['Settings, tool policies, skills, plugin manifests', 'localStorage'], ['API key and plugin credentials', H.secrets.persist() ? 'localStorage (remembered)' : 'sessionStorage (this tab only)'], ['Chats, memories, usage counters', 'IndexedDB'], ['Workspace files', 'your local folder, accessed via the File System Access API only after you pick it'],
      ].map(([a, b]) => el('tr', {}, [el('td', {}, [a]), el('td', { class: 'mono small' }, [b])])))])]),
      sec('Secrets', null, [
        el('label', { class: 'check' }, [persistToggle, el('span', {}, ['Remember API key and plugin credentials on this device', el('span', { class: 'help' }, ['Off = you re-enter them each time you open the app; they are cleared when the tab closes.'])])]),
        el('div', { class: 'row gap', style: 'margin-top:8px' }, [el('button', { class: 'btn sm danger-outline', onclick: () => { if (confirm('Forget the API key and all plugin credentials?')) { H.secrets.wipe(); H.toast('Secrets wiped', 'success'); openSettings('security'); } } }, ['Forget all secrets'])]),
        el('p', { class: 'help', style: 'margin-top:10px' }, ['Exports never include secrets. Anyone with access to this browser profile (or a malicious extension) could read stored secrets, as with any web app.']),
      ]),
      sec('Network: who this app talks to', 'Right now, requests can go to these hosts and nowhere else. Web pages the model fetches are requested directly from your browser.', [
        el('table', { class: 'table' }, [el('tbody', {}, endpoints.map(([n, u, w]) => el('tr', {}, [el('td', {}, [n]), el('td', { class: 'mono small' }, [u]), el('td', { class: 'small muted' }, [w])])))]),
      ]),
      sec('Web access', 'By default the browser fetches pages directly; sites that block cross-origin requests simply fail and the model is told to use open_url instead. Enabling any option below sends URLs or queries to a third party.', [
        field('CORS proxy (optional). Only use one you host yourself. Format: https://proxy/?url={url}', 'corsProxy', 'text'),
        check('Use r.jina.ai as a fallback reader (third party)', 'jinaFallback', 'sends fetched URLs to jina.ai'),
        field('Web search URL template ({q} = query). Leave empty to keep web_search disabled.', 'searchTemplate', 'text', { placeholder: 'e.g. https://your-searxng/search?q={q}&format=json' }),
        el('div', { class: 'row gap' }, [field('Search API key header (optional)', 'searchKeyHeader'), field('Search API key value', 'searchKeyValue', 'password')]),
        el('p', { class: 'help', style: 'margin-top:4px' }, ['Self-hosted options that keep queries in-house: a SearXNG instance, or an internal proxy. Keyed commercial APIs (Brave, Bing) also work but are third parties.']),
      ]),
      sec('Code execution & rendering', null, [el('ul', { class: 'help-list' }, [
        el('li', {}, ['JavaScript runs in a Web Worker with no DOM or workspace access; Python runs in Pyodide (WebAssembly) in a Worker. Both can make network requests, so run_* tools ask for permission by default. calculate, json_query and plugin expressions run in a Worker with all network APIs removed.']),
        el('li', {}, ['HTML previews render in a sandboxed iframe (unique origin) with an injected Content Security Policy: no fetch/XHR/WebSocket, no form posts, no remote images; scripts only inline or from the two CDNs the app itself uses.']),
        el('li', {}, ['Markdown from the model is sanitized with DOMPurify; images are shown as click-to-load placeholders so a reply can never trigger a request on its own.']),
        el('li', {}, ['web_fetch and http_request ask once per site (origin) in Default and Plan mode; "Allow this site for session" / "Always allow this site" remember the answer. A request routed through a connected browser tab (your login session) always asks, in every mode.']),
        el('li', {}, ['Tool output is treated as untrusted; the system prompt tells the model not to follow instructions embedded in fetched content. Review permission prompts for http_request and plugin write calls, which could exfiltrate data if the model is manipulated.']),
      ])]),
      sec('Workspace & code', 'How the assistant reads the folder you open. Nothing here sends anything anywhere.', [
        check('Follow the project\'s .gitignore when listing and searching files', 'respectGitignore', 'off = only the usual noise folders (node_modules, dist, build…) are skipped'),
        check('Load AGENTS.md / CLAUDE.md from the workspace root as project instructions', 'projectContextFile', 'the file becomes part of the system prompt; turn this off for folders you do not trust'),
      ]),
      sec('Update checks', null, [check('Check GitHub for a newer version (startup and every hour)', 'checkUpdates', 'only a public version file is fetched; no data about you is sent')]),
      sec('Python runtime', null, [check('Allow downloading Pyodide from the configured URL when Python is first used', 'allowPyodideCdn'), field('Pyodide URL', 'pyodideUrl')]),
    ]);
  }
  function dataPanel() {
    return el('div', {}, [
      sec('Backup', 'Exports contain settings (without secrets), tool policies, plugins (without credentials), skills, chats, memories.', [el('div', { class: 'row gap wrap' }, [el('button', { class: 'btn', onclick: exportAll }, [H.icon('download'), 'Export everything']), el('button', { class: 'btn', onclick: importAll }, ['Import'])])]),
      sec('Danger zone', null, [el('div', { class: 'row gap wrap' }, [
        el('button', { class: 'btn danger-outline', onclick: async () => { if (confirm('Delete ALL chats?')) { await H.db.clearChats(); H.agent.reset(); renderChatList(); } } }, ['Delete all chats']),
        el('button', { class: 'btn danger-outline', onclick: () => { if (confirm('Reset settings to defaults? (API key is kept)')) { H.settings.reset(); openSettings('connection'); } } }, ['Reset settings']),
        el('button', { class: 'btn danger', onclick: async () => { if (confirm('Wipe EVERYTHING stored by this app in this browser (chats, settings, secrets, plugins, skills)?')) { await H.db.clearChats(); H.secrets.wipe(); localStorage.clear(); sessionStorage.clear(); indexedDB.deleteDatabase('llm-harness'); location.reload(); } } }, ['Wipe all local data']),
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
      ]), el('p', { class: 'help', style: 'margin-top:8px' }, ['Checks fetch a small version file from GitHub on startup and every hour; nothing else is sent. Turn it off in Security & privacy. Updating = download the newer folder and replace this one; your data stays in the browser.'])]),
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
        for (const n of m.removedNodes) { if (n.nodeType === 1 && n.classList?.contains('modal-overlay') && n._returnFocus && document.contains(n._returnFocus)) { try { n._returnFocus.focus(); } catch { } } }
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
    $('#settings-btn').onclick = () => openSettings('connection');
    $('#usage').onclick = () => openSettings('usage'); $('#ctx-meter').onclick = () => openSettings('usage');
    $('#sidebar-bug-btn').onclick = bugReport;
    const narrow = () => window.matchMedia('(max-width: 900px)').matches;
    const openDrawer = (on) => { $('#sidebar').classList.toggle('open', on); $('#backdrop').classList.toggle('hidden', !on); };
    $('#toggle-sidebar').onclick = () => { if (narrow()) openDrawer(!$('#sidebar').classList.contains('open')); else $('#sidebar').classList.toggle('collapsed'); };
    $('#backdrop').onclick = () => openDrawer(false);
    $('#chat-list').addEventListener('click', (e) => { if (narrow() && e.target.closest('.chat-item') && !e.target.closest('button')) openDrawer(false); });
    $('#new-chat').addEventListener('click', () => { if (narrow()) openDrawer(false); });
    window.addEventListener('resize', () => { if (!narrow()) openDrawer(false); });
    $('#ws-btn').onclick = async () => { try { await H.fs.pick(); H.toast('Workspace: ' + H.fs.name(), 'success'); } catch (e) { if (e.name !== 'AbortError') H.toast(e.message, 'error', 6000); } };
    $('#model-select').onchange = (e) => { H.settings.set({ model: e.target.value }); updateContextMeter(); };
    $('#mode-select').onchange = (e) => { H.settings.set({ chatMode: e.target.value }); updateModeUI(); };
    $('#more-btn').onclick = (e) => { e.stopPropagation(); $('#more-menu').classList.toggle('hidden'); };
    document.addEventListener('click', () => $('#more-menu').classList.add('hidden'));
    $('#usage-btn').onclick = () => openSettings('usage');
    $('#compact-btn').onclick = () => H.agent.compact(H.agent.current(), { manual: true });
    H.bus.on('compacting', (id, on) => { if (id === H.agent.current()?.id) { $('#compact-btn').disabled = on; if (on) H.toast('Compacting the conversation…', 'info', 3000); } });
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
    $('#export-chat').onclick = () => { const c = H.agent.current(); if (!c) return; const text = c.messages.map(m => m.role === 'tool' ? `### tool:${m.name}\n\`\`\`\n${H.clamp(m.content, 4000)}\n\`\`\`` : `### ${m.role}\n${m.display || (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))}${m.tool_calls?.length ? '\n\n' + m.tool_calls.map(t => `→ ${t.function.name}(${t.function.arguments})`).join('\n') : ''}`).join('\n\n'); H.download((c.title || 'chat').replace(/[^\w-]+/g, '_') + '.md', `# ${c.title}\n\n${text}`, 'text/markdown'); };
    $('#messages').addEventListener('scroll', () => { const b = $('#messages'); stick = b.scrollHeight - b.scrollTop - b.clientHeight < 80; updateScrollBtn(); });
    $('#scroll-bottom').onclick = () => { stick = true; scrollBottom(true); };
    $('#chat-search').addEventListener('input', () => renderChatList());
    fillModelSelect($('#model-select'), H.settings.get('models') || [], H.settings.get('model'));
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
    H.bus.on('workspace', updateWorkspaceBtn);
    H.bus.on('git-state', () => updateWorkspaceBtn());
    H.bus.on('preview', showPreview);
    H.bus.on('settings', (s) => { if ($('#mode-select').value !== s.chatMode) updateModeUI(); if ($('#model-select').value !== s.model) fillModelSelect($('#model-select'), s.models || [], s.model); });
    H.bus.on('perm-prompt', () => { try { if (document.hidden && Notification.permission === 'granted') new Notification('Permission needed', { body: 'The assistant is waiting for your approval.' }); } catch { } });
  }

  return { init, renderChat, renderChatList, refreshModels, openSettings, setStatus, updateWorkspaceBtn, md, updateContextMeter, applyTheme };
})();
