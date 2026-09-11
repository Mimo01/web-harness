/* LiteLLM (OpenAI-compatible) client with streaming + tool calls */
H.llm = (() => {
  const url = (p) => H.settings.get('baseUrl').replace(/\/+$/, '') + p;
  const headers = () => ({ 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + H.settings.apiKey() });

  async function listModels() {
    const r = await fetch(url('/v1/models'), { headers: headers() });
    if (!r.ok) throw new Error(`Models: HTTP ${r.status} ${await r.text()}`);
    const j = await r.json();
    return (j.data || []).map(m => m.id).sort();
  }

  /**
   * chat({messages, tools, signal, onDelta}) -> {content, tool_calls, usage, finish_reason}
   */
  async function chat({ messages, tools, signal, onDelta, model, temperature, maxTokens }) {
    const s = H.settings.get();
    const body = {
      model: model || s.model,
      messages,
      temperature: temperature ?? s.temperature,
      max_tokens: maxTokens ?? s.maxTokens,
      stream: !!s.streaming,
    };
    if (tools && tools.length) { body.tools = tools; body.tool_choice = 'auto'; }
    if (body.stream) body.stream_options = { include_usage: true };

    /* transient failures (429, 5xx, dropped connection) are retried with backoff. Nothing has been streamed while
       this loop runs — the body is only read after it — so a retry can never duplicate text the caller has seen. */
    /* one abortable sleep for both retry paths: Stop must not have to wait out the backoff, and the abort
       listener has to come off the signal again or three retries leave three listeners behind */
    const backoff = (ms) => new Promise((res, rej) => {
      if (signal?.aborted) return rej(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      const onAbort = () => { clearTimeout(timer); rej(Object.assign(new Error('aborted'), { name: 'AbortError' })); };
      const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); res(); }, ms);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
    let r, attempt = 0;
    while (true) {
      try {
        r = await fetch(url('/v1/chat/completions'), { method: 'POST', headers: headers(), body: JSON.stringify(body), signal });
        if (r.ok) break;
        const t = await r.text();
        const transient = r.status === 429 || (r.status >= 500 && r.status <= 504);
        if (!transient || attempt >= 3) throw new Error(`LLM HTTP ${r.status}: ${H.clamp(t, 2000)}`);
        const ra = parseFloat(r.headers.get('retry-after')); const wait = (isFinite(ra) ? ra * 1000 : 1000 * 2 ** attempt) + Math.random() * 300;
        H.toast(`LiteLLM answered ${r.status}; retrying in ${Math.round(wait / 1000)} s (${attempt + 1}/3)…`, 'warn', wait);
        await backoff(wait);
        attempt++;
      } catch (e) {
        if (e.name === 'AbortError' || attempt >= 3 || !/Failed to fetch|NetworkError|Load failed|network/i.test(e.message)) throw e;
        const wait = 1000 * 2 ** attempt + Math.random() * 300;
        H.toast(`Connection to LiteLLM failed; retrying in ${Math.round(wait / 1000)} s (${attempt + 1}/3)…`, 'warn', wait);
        await backoff(wait); attempt++;
      }
    }
    if (!body.stream) {
      const j = await r.json();
      const m = j.choices?.[0]?.message || {};
      onDelta && onDelta({ content: m.content || '', reasoning: m.reasoning_content || '' });
      return { content: m.content || '', reasoning: m.reasoning_content || '', tool_calls: m.tool_calls || [], usage: j.usage, finish_reason: j.choices?.[0]?.finish_reason };
    }
    // SSE parsing
    if (!r.body) throw new Error(`LiteLLM answered HTTP ${r.status} with an empty body where a stream was expected. Check that the proxy supports streaming for this model, or turn streaming off in Settings › General.`);
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '', raw = '', sawData = false, content = '', reasoning = '', usage = null, finish = null;
    const toolCalls = [];
    const errorOf = (j) => { const e = j?.error; if (!e) return null; return typeof e === 'string' ? e : (e.message || e.error?.message || JSON.stringify(e)); };
    const handle = (data) => {
      if (data === '[DONE]') return;
      const j = H.tryJSON(data, null); if (!j) return;
      sawData = true;
      const err = errorOf(j); if (err) throw new Error('LiteLLM error: ' + H.clamp(err, 600));   // an error chunk mid-stream must not end the turn as an empty reply
      if (j.usage) usage = j.usage;
      const ch = j.choices?.[0]; if (!ch) return;
      if (ch.finish_reason) finish = ch.finish_reason;
      const d = ch.delta || {};
      if (d.content) { content += d.content; onDelta && onDelta({ content: d.content }); }
      if (d.reasoning_content) { reasoning += d.reasoning_content; onDelta && onDelta({ reasoning: d.reasoning_content }); }
      if (d.tool_calls) for (const tc of d.tool_calls) {
        const i = tc.index ?? toolCalls.length;
        toolCalls[i] ||= { id: '', type: 'function', function: { name: '', arguments: '' } };
        const cur = toolCalls[i];
        if (tc.id && !cur.id) cur.id = tc.id;                                   // ids are not incremental
        /* names arrive either in pieces ("fs" + "_read") or repeated whole each chunk ("get_" then
           "get_datetime"): a repeat starts with what we already have and replaces it, anything else is appended */
        if (tc.function?.name) cur.function.name = tc.function.name.startsWith(cur.function.name) ? tc.function.name : cur.function.name + tc.function.name;
        if (tc.function?.arguments) {
          const d = tc.function.arguments, acc = cur.function.arguments;
          if (acc && d.length >= acc.length && d.startsWith(acc)) cur.function.arguments = d;   // cumulative style
          else if (acc && H.isCompleteJSON(acc) && d.trim().startsWith('{')) cur.function.arguments = d; // repeated full object
          else cur.function.arguments += d;                                       // incremental style
        }
        onDelta && onDelta({ toolCall: toolCalls[i] });
      }
    };
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = dec.decode(value, { stream: true }); buf += chunk; if (raw.length < 200000) raw += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1);
        if (line.startsWith('data:')) handle(line.slice(5).trim());
      }
    }
    if (buf.trim().startsWith('data:')) handle(buf.trim().slice(5).trim());
    if (!sawData && raw.trim()) {   // no SSE frames at all: the proxy answered with a plain JSON completion (or a JSON error)
      const j = H.tryJSON(raw.trim(), null);
      if (!j) throw new Error('Unexpected response from LiteLLM (not SSE, not JSON): ' + H.clamp(raw.trim(), 300));
      const err = errorOf(j); if (err) throw new Error('LiteLLM error: ' + H.clamp(err, 600));
      const m = j.choices?.[0]?.message || {};
      if (m.content) onDelta && onDelta({ content: m.content });
      return { content: m.content || '', reasoning: m.reasoning_content || '', tool_calls: m.tool_calls || [], usage: j.usage, finish_reason: j.choices?.[0]?.finish_reason };
    }
    return { content, reasoning, tool_calls: toolCalls.filter(Boolean), usage, finish_reason: finish };
  }

  /* Whisper-style transcription through the proxy (/v1/audio/transcriptions) */
  async function transcribe(file, model) {
    const fd = new FormData(); fd.append('file', file, file.name || 'audio.webm'); fd.append('model', model); fd.append('response_format', 'json');
    const r = await fetch(url('/v1/audio/transcriptions'), { method: 'POST', headers: { 'Authorization': 'Bearer ' + H.settings.apiKey() }, body: fd });
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${H.clamp(await r.text(), 300)}`);
    const j = await r.json(); return j.text || '';
  }
  return { listModels, chat, transcribe };
})();
