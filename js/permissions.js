/* Tool permission policy: allow | ask | deny per tool, with session grants and a permission prompt */
H.perms = (() => {
  const KEY = 'harness.perms.v1';
  let rules = H.tryJSON(localStorage.getItem(KEY), {});   // { toolName: 'allow'|'ask'|'deny' }
  const session = new Set();                               // tools allowed for this session
  const save = () => { localStorage.setItem(KEY, JSON.stringify(rules)); H.bus.emit('perms', rules); };

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

  /** returns true if allowed, false if denied. May prompt user. */
  async function check(tool, args, ctx) {
    if ((H.settings.get('disabledTools') || []).includes(tool.name)) return { ok: false, reason: 'Tool is disabled in settings.' };
    const p = policyFor(tool);
    if (p === 'allow') return { ok: true };
    if (p === 'deny') return { ok: false, reason: 'Denied by permission policy.' };
    if (session.has(tool.name)) return { ok: true };
    const decision = await prompt(tool, args, ctx);
    if (decision === 'once') return { ok: true };
    if (decision === 'session') { session.add(tool.name); return { ok: true }; }
    if (decision === 'always') { rules[tool.name] = 'allow'; save(); return { ok: true }; }
    if (decision === 'never') { rules[tool.name] = 'deny'; save(); return { ok: false, reason: 'User denied and set policy to deny.' }; }
    return { ok: false, reason: 'User denied this tool call.' + (decision && decision.startsWith('msg:') ? ' Message: ' + decision.slice(4) : '') };
  }

  /* Modal prompt; resolves to 'once' | 'session' | 'always' | 'deny' | 'never' | 'msg:<text>' */
  function prompt(tool, args, ctx) {
    return new Promise((resolve) => {
      const argStr = JSON.stringify(args, null, 2);
      const overlay = H.el('div', { class: 'modal-overlay perm' });
      const box = H.el('div', { class: 'modal perm-modal' }, [
        H.el('div', { class: 'modal-head' }, [H.el('h3', {}, ['Permission required']), H.el('span', { class: 'spacer' }), H.el('span', { class: 'chip risk-' + (tool.risk || 'write') }, [tool.risk || 'write'])]),
        H.el('p', { class: 'muted', style: 'margin:0 0 4px' }, [`The assistant wants to run `, H.el('code', {}, [tool.name]), tool.plugin ? ` from the ${tool.plugin} plugin` : '', '.']),
        H.el('p', { class: 'small muted', style: 'margin:0 0 10px' }, [tool.description || '']),
        H.el('pre', { class: 'perm-args' }, [H.clamp(argStr, 4000)]),
        H.el('textarea', { class: 'perm-msg', placeholder: 'Optional: tell the assistant why you are denying / what to do instead', rows: 2 }),
        H.el('div', { class: 'row gap wrap perm-actions' }, [
          H.el('button', { class: 'btn primary', onclick: () => done('once') }, ['Allow once']),
          H.el('button', { class: 'btn', onclick: () => done('session') }, ['Allow for session']),
          H.el('button', { class: 'btn', onclick: () => done('always') }, ['Always allow']),
          H.el('span', { class: 'spacer' }),
          H.el('button', { class: 'btn danger-outline', onclick: () => done('deny') }, ['Deny']),
          H.el('button', { class: 'btn danger-outline', onclick: () => done('never') }, ['Never allow']),
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
    check, policyFor, defaultFor, effectiveMode, setOverride: (m) => { override = m; H.bus.emit('mode', effectiveMode()); },
    rules: () => rules,
    setRule: (name, pol) => { if (pol === 'default') delete rules[name]; else rules[name] = pol; save(); },
    clearSession: () => session.clear(),
    reset: () => { rules = {}; save(); },
  };
})();
