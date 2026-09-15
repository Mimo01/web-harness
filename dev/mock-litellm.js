/* Minimal OpenAI-compatible mock for testing the harness without a real LiteLLM.
   Behaviour: if the last message is a user message containing "calc", it emits a tool call to `calculate`;
   if it contains "ask", it calls fs_write (to exercise the permission prompt); "steps" produces a task_list,
   "fanout" three sub-agents at once; otherwise it streams a text reply that echoes tool results.
   Every request is logged with the things that are hard to see from the browser: which model, what reasoning
   effort was asked for, where the cache breakpoints landed, and how long the stable prefix is. */
const http = require('http');
const fs = require('fs');
/* the prefix as the provider would see it: everything up to and including the last cache breakpoint. Logged as
   a length and a hash so two consecutive requests can be compared at a glance — same hash, same cache. */
const crypto = require('crypto');
let reqNo = 0;
function logRequest(j) {
  const msgs = j.messages || [];
  const marks = [];
  msgs.forEach((m, i) => { if (Array.isArray(m.content) && m.content.some(p => p.cache_control)) marks.push(i); });
  const upto = marks.length ? marks[marks.length - 1] : -1;
  const prefix = JSON.stringify(msgs.slice(0, upto + 1));
  const line = `#${++reqNo} ${j.model}`
    + ` · ${msgs.length} msgs`
    + (j.reasoning_effort ? ` · effort=${j.reasoning_effort}` : '')
    + (marks.length ? ` · cache@[${marks.join(',')}] prefix ${prefix.length}b ${crypto.createHash('sha1').update(prefix).digest('hex').slice(0, 8)}` : ' · no cache markers')
    + ` · system ${(typeof msgs[0]?.content === 'string' ? msgs[0].content : JSON.stringify(msgs[0]?.content || '')).length}b`;
  console.log(line);
  if (process.env.DUMP) fs.writeFileSync(`${process.env.DUMP}/req-${reqNo}.json`, JSON.stringify(j, null, 2));
}
const send = (res, obj) => res.write('data: ' + JSON.stringify(obj) + '\n\n');
http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (req.url.endsWith('/models')) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ data: [{ id: 'mock-gpt' }, { id: 'mock-claude' }] })); }
  if (req.method !== 'POST') { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end('{"error":"not found"}'); }
  let body = ''; req.on('data', c => body += c); req.on('end', () => {
    let j; try { j = JSON.parse(body); } catch { res.writeHead(400); return res.end('bad json'); } const msgs = j.messages; const last = msgs[msgs.length - 1];
    logRequest(j);
    /* What the user actually typed. A message carries more than that — image parts, and the <environment>
       block the harness stamps on every turn — and matching a scenario keyword against that block fires the
       wrong branch for every message (the block says "ask the user to…", which is not the user saying "ask"). */
    const said = (m) => {
      if (!m) return '';
      const text = typeof m.content === 'string' ? m.content : (m.content || []).filter(p => p && p.type === 'text').map(p => p.text).join(' ');
      return String(text || '').replace(/<environment>[\s\S]*?<\/environment>/g, '').replace(/<attached_file[\s\S]*?<\/attached_file>/g, '');
    };
    const slow = msgs.some(m => m.role === 'user' && /slow/i.test(said(m)));
    if (slow) { const wait = (ms) => new Promise(r => setTimeout(r, ms)); (async () => { await wait(3000); go(); })(); return; }
    go();
    function go() {
    const id = 'chatcmpl-' + Date.now();
    const chunk = (delta, finish = null) => { sse(); send(res, { id, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] }); };
    const toolNames = (j.tools || []).map(t => t.function.name);
    const sse = () => { if (!res.headersSent) res.writeHead(200, { 'Content-Type': 'text/event-stream' }); };
    /* transient-failure scenario: first request of a "flaky" conversation gets a 503 */
    global.__flaky = global.__flaky || new Set();
    const flakyKey = msgs.filter(m => m.role === 'user').map(said).join('|');
    if (/flaky/i.test(flakyKey) && !global.__flaky.has(flakyKey)) { global.__flaky.add(flakyKey); res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '1' }); return res.end('{"error":"temporarily overloaded"}'); }
    /* parallel scenario: three read-only calls at once, each busy for ~400 ms */
    if (last.role === 'user' && /parallel/i.test(said(last)) && toolNames.includes('calculate')) {
      chunk({ role: 'assistant', content: '' });
      for (let i = 0; i < 3; i++) chunk({ tool_calls: [{ index: i, id: 'call_p' + i, type: 'function', function: { name: 'calculate', arguments: JSON.stringify({ expression: `(()=>{const t=Date.now();while(Date.now()-t<400);return ${i}})()` }) } }] });
      chunk({}, 'tool_calls'); send(res, { id, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } }); res.write('data: [DONE]\n\n'); return res.end();
    }
    const anyLoop = msgs.some(m => m.role === 'user' && /loop/i.test(said(m)));
    if (anyLoop && toolNames.includes('calculate') && !msgs.some(m => m.role === 'user' && /loop guard/i.test(said(m)))) {
      chunk({ role: 'assistant', content: '' });
      chunk({ tool_calls: [{ index: 0, id: 'call_' + Date.now(), type: 'function', function: { name: 'calculate', arguments: '{"expression":"1+1"}' } }] });
      chunk({}, 'tool_calls');
    } else if (last.role === 'user' && /question/i.test(said(last)) && toolNames.includes('ask_user')) {
      chunk({ role: 'assistant', content: 'Let me check with you. ' });
      chunk({ tool_calls: [{ index: 0, id: 'call_q', type: 'function', function: { name: 'ask_user', arguments: JSON.stringify({ question: 'Which colour do you prefer?', choices: ['red', 'blue'] }) } }] });
      chunk({}, 'tool_calls');
    } else if (msgs.some(m => m.role === 'user' && /steps/i.test(said(m))) && toolNames.includes('task_list')) {
      /* one step per turn, so the strip, the card and the tool-call limit all get something to do. It keeps
         going after its own tool results, which is what a real multi-step run looks like. */
      const written = msgs.filter(m => m.role === 'tool' && String(m.tool_call_id || '').startsWith('call_t')).length;
      const titles = ['Read the project overview', 'Find the failing test', 'Fix it', 'Re-run the tests'];
      const steps = titles.map((title, i) => ({ title, status: i < written ? 'done' : i === written ? 'doing' : 'todo' }));
      if (written >= titles.length) { for (const w of 'All four steps are done.'.split(/(?<= )/)) chunk({ content: w }); chunk({}, 'stop'); }
      else {
        chunk({ role: 'assistant', content: written ? '' : 'Here is how I will go about it. ' });
        chunk({ tool_calls: [{ index: 0, id: 'call_t' + written, type: 'function', function: { name: 'task_list', arguments: JSON.stringify({ steps }) } }] });
        chunk({}, 'tool_calls');
      }
    } else if (last.role === 'user' && /fanout/i.test(said(last)) && toolNames.includes('run_subagent')) {
      chunk({ role: 'assistant', content: 'Sending three sub-agents. ' });
      chunk({ tool_calls: [{ index: 0, id: 'call_f', type: 'function', function: { name: 'run_subagent', arguments: JSON.stringify({ tasks: ['Count the JavaScript files and calc 1+1', 'Summarize the README and calc 2+2', 'List the CSS files and calc 3+3'] }) } }] });
      chunk({}, 'tool_calls');
    } else if (last.role === 'user' && /calc/i.test(said(last)) && toolNames.includes('calculate')) {
      chunk({ role: 'assistant', content: 'Let me compute that. ' });
      chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'calculate', arguments: '{"expr' } }] });
      chunk({ tool_calls: [{ index: 0, function: { arguments: 'ession":"6*7"}' } }] });
      chunk({}, 'tool_calls');
    } else if (last.role === 'user' && /ask/i.test(said(last)) && toolNames.includes('fs_write')) {
      chunk({ role: 'assistant', content: '' });
      chunk({ tool_calls: [{ index: 0, id: 'call_2', type: 'function', function: { name: 'fs_write', arguments: JSON.stringify({ path: 'hello.txt', content: 'hi' }) } }] });
      chunk({}, 'tool_calls');
    } else if (/^You write skills/.test(String(msgs[0]?.content || ''))) {
      /* the skill editor's "Draft with the model" box: a one-shot call that must come back as a skill file */
      const text = `---\nname: standup\ndescription: Turn today's git log into a standup note\n---\n1. Call git_log for the last day.\n2. Group the commits by area.\n3. Write three lines: done, next, blocked.`;
      for (const w of text.split(/(?<=\n)/)) chunk({ content: w });
      chunk({}, 'stop');
    } else if (last.role === 'user' && /skill/i.test(said(last)) && toolNames.includes('skill_write')) {
      chunk({ role: 'assistant', content: 'Writing that skill. ' });
      chunk({ tool_calls: [{ index: 0, id: 'call_s', type: 'function', function: { name: 'skill_write', arguments: JSON.stringify({ name: /named copy/i.test(said(last)) ? 'copy' : 'standup', description: "Turn today's git log into a standup note", content: '1. Call git_log for the last day.\n2. Group the commits by area.\n3. Write three lines: done, next, blocked.' }) } }] });
      chunk({}, 'tool_calls');
    } else if (last.role === 'tool') {
      const text = `Tool **${last.tool_call_id}** returned:\n\n\`\`\`json\n${last.content}\n\`\`\`\n\nDone.`;
      for (const w of text.split(/(?<= )/)) chunk({ content: w });
      chunk({}, 'stop');
    } else {
      const text = `Echo (system prompt ${String(typeof msgs[0].content === 'string' ? msgs[0].content : JSON.stringify(msgs[0].content)).length} chars, ${toolNames.length} tools): ${said(last).slice(0, 120) || JSON.stringify(last.content).slice(0, 80)}`;
      for (const w of text.split(/(?<= )/)) chunk({ content: w });
      chunk({}, 'stop');
    }
    sse(); send(res, { id, choices: [], usage: { prompt_tokens: 123, completion_tokens: 45 } });
    res.write('data: [DONE]\n\n'); res.end();
    }
  });
}).listen(4000, '127.0.0.1', () => console.log('mock litellm on :4000'));
