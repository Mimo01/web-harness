/* Tool permission policy: allow | ask | deny per tool, with session grants and a permission prompt */
H.perms = (() => {
  const KEY = 'harness.perms.v1';
  let rules = H.tryJSON(localStorage.getItem(KEY), {});   // { toolName | 'tool@origin': 'allow'|'ask'|'deny' }
  const session = new Set();                               // tools / tool@origin keys allowed for this session
  const save = () => { H.store.write(KEY, rules); H.bus.emit('perms', rules); };

  /* default policy by tool risk level declared in tool definition */
  const defaultFor = (tool) => {
    if (!tool) return 'ask';
    if (tool.risk === 'safe') return 'allow';
    if (tool.risk === 'danger') return 'ask';
    return 'ask'; // 'write'
  };

  let override = null; // temporary mode override (e.g. while executing a plan)
  function effectiveMode() { return override || H.settings.get('chatMode') || 'default'; }
  function policyFor(tool) {
    const mode = effectiveMode();
    const explicit = rules[tool.name];
    if (explicit === 'deny') return 'deny';
    if (mode === 'plan') return tool.risk === 'safe' ? (H.settings.get('alwaysAsk') ? 'ask' : 'allow') : 'deny';
    if (mode === 'auto') return 'allow';
    if (H.settings.get('alwaysAsk')) return 'ask';
    return explicit || defaultFor(tool);
  }

  /* Scoped tools (web_fetch, http_request) declare scope(args) -> origin. Grants and rules are then keyed per
     origin ("web_fetch@https://example.com"): the first request to a new origin prompts once, "Allow for session"
     remembers the origin for this session, "Always allow this site" persists it. "Allow all" mode skips this.
     Tools may also declare mustAsk(args) -> { key, note } to force a confirmation regardless of mode or rules
     (used when a request would go through the user's logged-in browser tab). */
  const scopeKey = (tool, args) => { if (!tool.scope) return null; try { const s = tool.scope(args); return s ? tool.name + '@' + s : null; } catch { return null; } };
  const denied = (decision) => ({ ok: false, reason: 'User denied this tool call.' + (decision && decision.startsWith('msg:') ? ' Message: ' + decision.slice(4) : '') });

  /** true when check() would show a prompt for these arguments (keeps prompting calls out of parallel batches) */
  function willPrompt(tool, args) {
    if (tool.mustAsk) { const f = tool.mustAsk(args); if (f && !session.has(f.key)) return true; }
    const p = policyFor(tool);
    if (p !== 'allow') return p === 'ask';
    const sk = scopeKey(tool, args);
    return !!sk && effectiveMode() !== 'auto' && rules[tool.name] !== 'allow' && rules[sk] !== 'allow' && !session.has(sk);
  }

  /** returns { ok, reason? }. May prompt the user. */
  async function check(tool, args, ctx) {
    if ((H.settings.get('disabledTools') || []).includes(tool.name)) return { ok: false, reason: 'Tool is disabled in settings.' };
    // 1) forced confirmation, regardless of mode or rules
    const forced = tool.mustAsk ? tool.mustAsk(args) : null;
    if (forced) {
      if (session.has(forced.key)) return { ok: true };
      const sc = scopeKey(tool, args); const d = await prompt(tool, args, ctx, { scope: sc ? sc.slice(tool.name.length + 1) : null, note: forced.note, noAlways: true });
      if (d === 'session') session.add(forced.key);
      else if (d !== 'once') return denied(d);
      return { ok: true };
    }
    // 2) policy by tool
    const p = policyFor(tool);
    if (p === 'deny') return { ok: false, reason: 'Denied by permission policy.' };
    const sk = scopeKey(tool, args), key = sk || tool.name;
    if (sk && rules[sk] === 'deny') return { ok: false, reason: `Denied by permission policy for ${sk.slice(tool.name.length + 1)}.` };
    if (session.has(key) || (sk && rules[sk] === 'allow')) return { ok: true };
    // 3) a "safe" scoped tool still asks once per origin unless the whole tool was explicitly always-allowed, or mode is Allow all
    const scopedAsk = p === 'allow' && sk && effectiveMode() !== 'auto' && rules[tool.name] !== 'allow';
    if (p === 'allow' && !scopedAsk) return { ok: true };
    const scope = sk ? sk.slice(tool.name.length + 1) : null;
    const decision = await prompt(tool, args, ctx, scope ? { scope, note: `First ${tool.name} request to ${scope} in this session. Data in the URL or body leaves your browser for that site.` } : {});
    if (decision === 'once') return { ok: true };
    if (decision === 'session') { session.add(key); return { ok: true }; }
    if (decision === 'always') { rules[key] = 'allow'; save(); return { ok: true }; }
    if (decision === 'never') { rules[key] = 'deny'; save(); return { ok: false, reason: 'User denied and set policy to deny' + (scope ? ' for ' + scope : '') + '.' }; }
    return denied(decision);
  }

  /* Modal prompt; resolves to 'once' | 'session' | 'always' | 'deny' | 'never' | 'msg:<text>' */
  function prompt(tool, args, ctx, { scope, note, noAlways } = {}) {
    return new Promise((resolve) => {
      const argStr = JSON.stringify(args, null, 2);
      const overlay = H.el('div', { class: 'modal-overlay perm' });
      const box = H.el('div', { class: 'modal perm-modal' }, [
        H.el('div', { class: 'modal-head' }, [H.el('h3', {}, ['Permission required']), H.el('span', { class: 'spacer' }), H.el('span', { class: 'chip risk-' + (tool.risk || 'write') }, [tool.risk || 'write'])]),
        H.el('p', { class: 'muted', style: 'margin:0 0 4px' }, [`The assistant wants to run `, H.el('code', {}, [tool.name]), tool.plugin ? ` from the ${tool.plugin} plugin` : '', ...(scope ? [' on ', H.el('b', {}, [scope])] : []), '.']),
        H.el('p', { class: 'small muted', style: 'margin:0 0 10px' }, [tool.description || '']),
        note ? H.el('p', { class: 'small perm-note' }, [note]) : '',
        H.el('pre', { class: 'perm-args' }, [H.clamp(argStr, 4000)]),
        H.el('textarea', { class: 'perm-msg', placeholder: 'Optional: tell the assistant why you are denying / what to do instead', rows: 2 }),
        H.el('div', { class: 'row gap wrap perm-actions' }, [
          H.el('button', { class: 'btn primary', onclick: () => done('once') }, ['Allow once']),
          H.el('button', { class: 'btn', onclick: () => done('session') }, [scope ? 'Allow this site for session' : 'Allow for session']),
          noAlways ? '' : H.el('button', { class: 'btn', onclick: () => done('always') }, [scope ? 'Always allow this site' : 'Always allow']),
          H.el('span', { class: 'spacer' }),
          H.el('button', { class: 'btn danger-outline', onclick: () => done('deny') }, ['Deny']),
          noAlways ? '' : H.el('button', { class: 'btn danger-outline', onclick: () => done('never') }, [scope ? 'Never allow this site' : 'Never allow']),
        ]),
      ]);
      overlay.append(box); document.body.append(overlay);
      const done = (d) => {
        const msg = box.querySelector('.perm-msg').value.trim();
        overlay.remove();
        resolve(d === 'deny' && msg ? 'msg:' + msg : d);
      };
      H.bus.emit('perm-prompt', { tool, args });
    });
  }

  return {
    check, willPrompt, policyFor, defaultFor, effectiveMode, setOverride: (m) => { override = m; H.bus.emit('mode', effectiveMode()); },
    rules: () => rules,
    setRule: (name, pol) => { if (pol === 'default') delete rules[name]; else rules[name] = pol; save(); },
    clearSession: () => session.clear(),
    reset: () => { rules = {}; save(); },
  };
})();
