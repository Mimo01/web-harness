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
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const slow = msgs.some(m => m.role === 'user' && typeof m.content === 'string' && /slow/i.test(m.content));
    if (slow) { const wait = (ms) => new Promise(r => setTimeout(r, ms)); (async () => { await wait(3000); go(); })(); return; }
    go();
    function go() {
    const id = 'chatcmpl-' + Date.now();
    const chunk = (delta, finish = null) => send(res, { id, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] });
    const toolNames = (j.tools || []).map(t => t.function.name);
    const anyLoop = msgs.some(m => m.role === 'user' && typeof m.content === 'string' && /loop/i.test(m.content));
    if (anyLoop && toolNames.includes('calculate') && !msgs.some(m => m.role === 'user' && /loop guard/i.test(m.content))) {
      chunk({ role: 'assistant', content: '' });
      chunk({ tool_calls: [{ index: 0, id: 'call_' + Date.now(), type: 'function', function: { name: 'calculate', arguments: '{"expression":"1+1"}' } }] });
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
    } else if (last.role === 'tool') {
      const text = `Tool **${last.tool_call_id}** returned:\n\n\`\`\`json\n${last.content}\n\`\`\`\n\nDone.`;
      for (const w of text.split(/(?<= )/)) chunk({ content: w });
      chunk({}, 'stop');
    } else {
      const text = `Echo (system prompt ${msgs[0].content.length} chars, ${toolNames.length} tools): ${typeof last.content === 'string' ? last.content : JSON.stringify(last.content).slice(0, 80)}`;
      for (const w of text.split(/(?<= )/)) chunk({ content: w });
      chunk({}, 'stop');
    }
    send(res, { id, choices: [], usage: { prompt_tokens: 123, completion_tokens: 45 } });
    res.write('data: [DONE]\n\n'); res.end();
    }
  });
}).listen(4000, '127.0.0.1', () => console.log('mock litellm on :4000'));
