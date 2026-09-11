/* Minimal OpenAI-compatible mock for testing the harness without a real LiteLLM.
   Behaviour: if the last message is a user message containing "calc", it emits a tool call to `calculate`;
   if it contains "ask", it calls fs_write (to exercise the permission prompt); otherwise it streams a text reply that echoes tool results. */
const http = require('http');
const send = (res, obj) => res.write('data: ' + JSON.stringify(obj) + '\n\n');
http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (req.url.endsWith('/models')) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ data: [{ id: 'mock-gpt' }, { id: 'mock-claude' }] })); }
  if (req.method !== 'POST') { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end('{"error":"not found"}'); }
  let body = ''; req.on('data', c => body += c); req.on('end', () => {
    let j; try { j = JSON.parse(body); } catch { res.writeHead(400); return res.end('bad json'); } const msgs = j.messages; const last = msgs[msgs.length - 1];
    const slow = msgs.some(m => m.role === 'user' && typeof m.content === 'string' && /slow/i.test(m.content));
    if (slow) { const wait = (ms) => new Promise(r => setTimeout(r, ms)); (async () => { await wait(3000); go(); })(); return; }
    go();
    function go() {
    const id = 'chatcmpl-' + Date.now();
    const chunk = (delta, finish = null) => { sse(); send(res, { id, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] }); };
    const toolNames = (j.tools || []).map(t => t.function.name);
    const sse = () => { if (!res.headersSent) res.writeHead(200, { 'Content-Type': 'text/event-stream' }); };
    /* transient-failure scenario: first request of a "flaky" conversation gets a 503 */
    global.__flaky = global.__flaky || new Set();
    const flakyKey = msgs.filter(m => m.role === 'user').map(m => m.content).join('|');
    if (/flaky/i.test(flakyKey) && !global.__flaky.has(flakyKey)) { global.__flaky.add(flakyKey); res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '1' }); return res.end('{"error":"temporarily overloaded"}'); }
    /* parallel scenario: three read-only calls at once, each busy for ~400 ms */
    if (last.role === 'user' && /parallel/i.test(last.content) && toolNames.includes('calculate')) {
      chunk({ role: 'assistant', content: '' });
      for (let i = 0; i < 3; i++) chunk({ tool_calls: [{ index: i, id: 'call_p' + i, type: 'function', function: { name: 'calculate', arguments: JSON.stringify({ expression: `(()=>{const t=Date.now();while(Date.now()-t<400);return ${i}})()` }) } }] });
      chunk({}, 'tool_calls'); send(res, { id, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } }); res.write('data: [DONE]\n\n'); return res.end();
    }
    const anyLoop = msgs.some(m => m.role === 'user' && typeof m.content === 'string' && /loop/i.test(m.content));
    if (anyLoop && toolNames.includes('calculate') && !msgs.some(m => m.role === 'user' && /loop guard/i.test(m.content))) {
      chunk({ role: 'assistant', content: '' });
      chunk({ tool_calls: [{ index: 0, id: 'call_' + Date.now(), type: 'function', function: { name: 'calculate', arguments: '{"expression":"1+1"}' } }] });
      chunk({}, 'tool_calls');
    } else if (last.role === 'user' && /question/i.test(last.content) && toolNames.includes('ask_user')) {
      chunk({ role: 'assistant', content: 'Let me check with you. ' });
      chunk({ tool_calls: [{ index: 0, id: 'call_q', type: 'function', function: { name: 'ask_user', arguments: JSON.stringify({ question: 'Which colour do you prefer?', choices: ['red', 'blue'] }) } }] });
      chunk({}, 'tool_calls');
    } else if (last.role === 'user' && /calc/i.test(last.content) && toolNames.includes('calculate')) {
      chunk({ role: 'assistant', content: 'Let me compute that. ' });
      chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'calculate', arguments: '{"expr' } }] });
      chunk({ tool_calls: [{ index: 0, function: { arguments: 'ession":"6*7"}' } }] });
      chunk({}, 'tool_calls');
    } else if (last.role === 'user' && /ask/i.test(last.content) && toolNames.includes('fs_write')) {
      chunk({ role: 'assistant', content: '' });
      chunk({ tool_calls: [{ index: 0, id: 'call_2', type: 'function', function: { name: 'fs_write', arguments: JSON.stringify({ path: 'hello.txt', content: 'hi' }) } }] });
      chunk({}, 'tool_calls');
    } else if (/^You write skills/.test(String(msgs[0]?.content || ''))) {
      /* the skill editor's "Draft with the model" box: a one-shot call that must come back as a skill file */
      const text = `---\nname: standup\ndescription: Turn today's git log into a standup note\n---\n1. Call git_log for the last day.\n2. Group the commits by area.\n3. Write three lines: done, next, blocked.`;
      for (const w of text.split(/(?<=\n)/)) chunk({ content: w });
      chunk({}, 'stop');
    } else if (last.role === 'user' && /skill/i.test(last.content) && toolNames.includes('skill_write')) {
      chunk({ role: 'assistant', content: 'Writing that skill. ' });
      chunk({ tool_calls: [{ index: 0, id: 'call_s', type: 'function', function: { name: 'skill_write', arguments: JSON.stringify({ name: /named copy/i.test(last.content) ? 'copy' : 'standup', description: "Turn today's git log into a standup note", content: '1. Call git_log for the last day.\n2. Group the commits by area.\n3. Write three lines: done, next, blocked.' }) } }] });
      chunk({}, 'tool_calls');
    } else if (last.role === 'tool') {
      const text = `Tool **${last.tool_call_id}** returned:\n\n\`\`\`json\n${last.content}\n\`\`\`\n\nDone.`;
      for (const w of text.split(/(?<= )/)) chunk({ content: w });
      chunk({}, 'stop');
    } else {
      const text = `Echo (system prompt ${msgs[0].content.length} chars, ${toolNames.length} tools): ${typeof last.content === 'string' ? last.content : JSON.stringify(last.content).slice(0, 80)}`;
      for (const w of text.split(/(?<= )/)) chunk({ content: w });
      chunk({}, 'stop');
    }
    sse(); send(res, { id, choices: [], usage: { prompt_tokens: 123, completion_tokens: 45 } });
    res.write('data: [DONE]\n\n'); res.end();
    }
  });
}).listen(4000, '127.0.0.1', () => console.log('mock litellm on :4000'));
