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

    const r = await fetch(url('/v1/chat/completions'), { method: 'POST', headers: headers(), body: JSON.stringify(body), signal });
    if (!r.ok) {
      const t = await r.text();
      throw new Error(`LLM HTTP ${r.status}: ${H.clamp(t, 2000)}`);
    }
    if (!body.stream) {
      const j = await r.json();
      const m = j.choices?.[0]?.message || {};
      onDelta && onDelta({ content: m.content || '', reasoning: m.reasoning_content || '' });
      return { content: m.content || '', reasoning: m.reasoning_content || '', tool_calls: m.tool_calls || [], usage: j.usage, finish_reason: j.choices?.[0]?.finish_reason };
    }
    // SSE parsing
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '', content = '', reasoning = '', usage = null, finish = null;
    const toolCalls = [];
    const handle = (data) => {
      if (data === '[DONE]') return;
      const j = H.tryJSON(data, null); if (!j) return;
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
        if (tc.function?.name && !cur.function.name.includes(tc.function.name)) cur.function.name += tc.function.name;
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
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1);
        if (line.startsWith('data:')) handle(line.slice(5).trim());
      }
    }
    if (buf.trim().startsWith('data:')) handle(buf.trim().slice(5).trim());
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
