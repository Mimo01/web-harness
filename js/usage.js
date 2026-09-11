/* Usage, context and cost tracking */
H.usage = (() => {
  const TOTAL_KEY = 'usage.total';
  let total = null; // { prompt, completion, cost, requests, byModel: { model: {prompt, completion, cost, requests} }, byDay: { 'YYYY-MM-DD': {...} } }

  async function loadTotal() { if (!total) total = (await H.db.kvGet(TOTAL_KEY)) || { prompt: 0, completion: 0, cost: 0, requests: 0, byModel: {}, byDay: {} }; return total; }

  /* pricing: manual override > LiteLLM model info */
  /* cached prompt tokens as reported by the API (OpenAI: prompt_tokens_details.cached_tokens; Anthropic via LiteLLM: cache_read_input_tokens) */
  const cachedOf = (u) => (u?.prompt_tokens_details?.cached_tokens ?? u?.cache_read_input_tokens ?? 0) || 0;
  function priceFor(model) {
    const s = H.settings.get();
    const man = s.pricing?.[model];
    const info = s.modelInfo?.[model];
    const inPerTok = man?.in != null ? man.in / 1e6 : (info?.inCost ?? null);
    return {
      inPerTok,
      cachedPerTok: man?.cached != null ? man.cached / 1e6 : (info?.cacheReadCost ?? (inPerTok != null ? inPerTok * 0.5 : null)),   // default: half price when the provider does not say
      outPerTok: man?.out != null ? man.out / 1e6 : (info?.outCost ?? null),
      context: man?.context || info?.maxInput || s.defaultContext,
      source: man?.in != null ? 'manual' : info?.inCost != null ? 'litellm' : 'unknown',
    };
  }
  function cost(model, promptTok, completionTok, cachedTok = 0) {
    const p = priceFor(model);
    if (p.inPerTok == null && p.outPerTok == null) return null;
    const cached = Math.min(cachedTok || 0, promptTok || 0);
    return ((promptTok || 0) - cached) * (p.inPerTok || 0) + cached * (p.cachedPerTok || 0) + (completionTok || 0) * (p.outPerTok || 0);
  }
  const costOfUsage = (model, u) => cost(model, u?.prompt_tokens, u?.completion_tokens, cachedOf(u));
  const fmtCost = (c) => c == null ? '—' : c < 0.01 ? '$' + c.toFixed(4) : '$' + c.toFixed(c < 1 ? 3 : 2);
  const fmtTok = (n) => n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n || 0);

  /* record one API response */
  async function record(model, u) {
    if (!u) return;
    const t = await loadTotal();
    const c = costOfUsage(model, u) || 0; const cached = cachedOf(u);
    const add = (o) => { o.prompt += u.prompt_tokens || 0; o.completion += u.completion_tokens || 0; o.cached = (o.cached || 0) + cached; o.cost += c; o.requests += 1; };
    add(t);
    add(t.byModel[model] ||= { prompt: 0, completion: 0, cost: 0, requests: 0 });
    const day = new Date().toISOString().slice(0, 10);
    add(t.byDay[day] ||= { prompt: 0, completion: 0, cost: 0, requests: 0 });
    await H.db.kvSet(TOTAL_KEY, t);
    H.bus.emit('usage-total', t);
    return c;
  }

  /* cost of a chat computed from per-message token counts at today's prices (so late-arriving pricing still applies) */
  function chatCost(chat) {
    let cost = 0, known = false, partial = false;
    for (const m of chat?.messages || []) {
      const u = m.meta?.usage; if (!u) continue;
      const c = costOfUsage(m.meta.model || H.settings.get('model'), u);
      if (c == null) partial = true; else { cost += c; known = true; }
    }
    return { cost, known, partial };
  }
  const cost_ = (m, p, c) => cost(m, p, c);

  /* estimate the current context size of a chat (tokens that would be sent on the next request) */
  let specsMemo = { list: null, tokens: 0 };
  function specsEstimate() { const specs = H.tools.openaiSpecs(); const key = specs.map(s => s.function.name).join(','); if (specsMemo.list !== key) specsMemo = { list: key, tokens: H.estTokens(JSON.stringify(specs)) }; return specsMemo.tokens; }
  const msgTokens = (m) => H.estTokens(typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '')) + (m.tool_calls ? H.estTokens(JSON.stringify(m.tool_calls)) : 0) + 4;
  const contextEstimate = (chat) => contextBreakdown(chat).total;
  /* the same estimate, split into the parts the popup shows: what is always sent (system prompt + tool
     schemas) and what the conversation itself costs. `anchored` says whether a real prompt_tokens figure
     from the last reply backs the number, or whether the whole thing is an estimate. */
  function contextBreakdown(chat) {
    const model = H.settings.get('model');
    const ctx = priceFor(model).context || 128000;
    const fixed = H.estTokens(H.agent.systemPrompt()) + specsEstimate();
    const msgs = chat?.messages || [];
    let total = 0, anchored = false;
    let lastPromptIdx = -1, lastPrompt = 0;
    msgs.forEach((m, i) => { if (m.role === 'assistant' && !m.meta?.compacted && m.meta?.usage?.prompt_tokens) { lastPromptIdx = i; lastPrompt = m.meta.usage.prompt_tokens + (m.meta.usage.completion_tokens || 0); } });
    const summaryAfter = msgs.some((m, i) => m.meta?.summary && i > lastPromptIdx);
    if (lastPromptIdx >= 0 && !summaryAfter) {
      anchored = true;
      total = lastPrompt;
      for (let i = lastPromptIdx + 1; i < msgs.length; i++) { const m = msgs[i]; if (m.meta?.compacted) continue; total += msgTokens(m); }
    } else {
      // no usage figure to anchor on (fresh chat or just compacted): estimate what would be sent now
      total = fixed;
      for (const m of H.agent.apiMessages(msgs)) total += msgTokens(m);
    }
    const shown = Math.min(total, ctx);
    const fixedPart = Math.min(fixed, shown);
    return {
      model, ctx, total, anchored,
      pct: Math.min(100, Math.round(total / ctx * 100)),
      fixed: fixedPart,
      conversation: Math.max(0, shown - fixedPart),
      free: Math.max(0, ctx - total),
    };
  }

  /* per-chat token totals; cached tokens are summed from the messages because chat.usage does not track them */
  function chatTokens(chat) {
    const u = chat?.usage || {};
    let cached = 0;
    for (const m of chat?.messages || []) cached += cachedOf(m.meta?.usage);
    return { prompt: u.prompt || 0, completion: u.completion || 0, cached, requests: u.requests || 0 };
  }

  /* fetch LiteLLM /model/info for context windows + prices (best effort) */
  async function refreshModelInfo() {
    const base = H.settings.get('baseUrl').replace(/\/+$/, '');
    const headers = { Authorization: 'Bearer ' + H.settings.apiKey() };
    for (const path of ['/model/info', '/v1/model/info']) {
      try {
        const r = await fetch(base + path, { headers });
        if (!r.ok) continue;
        const j = await r.json();
        const info = {};
        for (const m of j.data || []) {
          const mi = m.model_info || {};
          info[m.model_name] = { maxInput: mi.max_input_tokens || mi.max_tokens || null, maxOutput: mi.max_output_tokens || null, inCost: mi.input_cost_per_token ?? null, outCost: mi.output_cost_per_token ?? null, cacheReadCost: mi.cache_read_input_token_cost ?? null, provider: mi.litellm_provider || null };
        }
        H.settings.set({ modelInfo: info });
        H.bus.emit('usage');
        return info;
      } catch { }
    }
    return null;
  }

  async function aggregateChats() {
    const chats = await H.db.listChats();
    const out = { chats: chats.length, prompt: 0, completion: 0, cost: 0, top: [] };
    for (const c of chats) { const u = c.usage || {}; out.prompt += u.prompt || 0; out.completion += u.completion || 0; out.cost += u.cost || 0; out.top.push({ id: c.id, title: c.title, tokens: (u.prompt || 0) + (u.completion || 0), cost: u.cost || 0 }); }
    out.top.sort((a, b) => b.tokens - a.tokens); out.top = out.top.slice(0, 8);
    return out;
  }

  return { priceFor, cost, costOfUsage, cachedOf, chatCost, chatTokens, fmtCost, fmtTok, record, contextEstimate, contextBreakdown, refreshModelInfo, loadTotal, aggregateChats, resetTotal: async () => { total = { prompt: 0, completion: 0, cost: 0, requests: 0, byModel: {}, byDay: {} }; await H.db.kvSet(TOTAL_KEY, total); H.bus.emit('usage-total', total); } };
})();
