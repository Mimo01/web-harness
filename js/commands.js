/* System commands: /name typed in the chat box, executed here in the browser.
   They never reach the model and never become a message. Skills use the same /name syntax
   (js/skills.js) and are looked up only after no command matches, so commands win a name clash. */
H.commands = (() => {

  /* the assistant messages after the last real user message = the last reply, as the turn Copy button sees it */
  function lastReply(c) {
    const msgs = (c?.messages || []).filter(m => !m.meta?.compacted);
    let start = 0;
    for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === 'user') { start = i + 1; break; }
    return msgs.slice(start).filter(m => m.role === 'assistant' && m.content).map(m => m.content).join('\n\n').trim();
  }
  /* The fence can be longer than three backticks — that is how a reply shows markdown that itself contains a code
     block — so the closing run has to match the opening one, or the inner fence would end the outer block. */
  const lastCodeBlock = (md) => {
    const blocks = [...md.matchAll(/(?:^|\n)(`{3,})[\w-]*[ \t]*\n([\s\S]*?)\n?\1[ \t]*(?=\n|$)/g)];
    return blocks.length ? blocks.at(-1)[2] : '';
  };

  async function toClipboard(text, what) {
    try { await navigator.clipboard.writeText(text); H.toast(what + ' copied', 'success', 1800); }
    catch (e) { H.toast(H.explainError(e), 'error', 6000); }
  }

  const list = [
    {
      name: 'compact', hint: '', description: 'Summarise the earlier part of this chat to free up context.',
      run: () => H.agent.compact(H.agent.current(), { manual: true }),
    },
    {
      name: 'copy', hint: '[all|code]', description: 'Copy the last reply to the clipboard (all = whole chat, code = last code block).',
      /* typing the space after /copy turns the menu into this list; the nameless one is the bare command */
      args: [
        { name: '', description: 'The last reply, as markdown.' },
        { name: 'all', description: 'The whole chat, as markdown (same text as Export).' },
        { name: 'code', description: 'The last code block of the last reply.' },
      ],
      run: async (args) => {
        const c = H.agent.current();
        const what = (args || '').trim().toLowerCase();
        if (what === 'all') {
          if (!c?.messages.length) return H.toast('Nothing to copy: this chat is empty.', 'warn');
          return toClipboard(H.chatMarkdown(c), 'Chat');
        }
        const reply = lastReply(c);
        if (!reply) return H.toast('Nothing to copy: no reply in this chat yet.', 'warn');
        if (what === 'code') {
          const code = lastCodeBlock(reply);
          if (!code) return H.toast('The last reply has no code block.', 'warn');
          return toClipboard(code, 'Code block');
        }
        if (what) return H.toast(`Unknown option "${what}". Use /copy, /copy all or /copy code.`, 'warn');
        return toClipboard(reply, 'Last reply');
      },
    },
  ];

  /* "/copy all" -> { cmd, args }; null when the text is not a command */
  function match(text) {
    const m = String(text || '').match(/^\/([a-z0-9_-]+)\s*([\s\S]*)$/i);
    if (!m) return null;
    const cmd = list.find(x => x.name === m[1].toLowerCase());
    return cmd ? { cmd, args: m[2].trim() } : null;
  }

  return {
    list: () => list,
    get: (name) => list.find(c => c.name === name),
    match,
    /* returns true when the text was a command (and was handled here) */
    run: (text) => { const m = match(text); if (!m) return false; m.cmd.run(m.args); return true; },
  };
})();
