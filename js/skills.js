/* Skills: reusable instruction sets (markdown with optional YAML-ish frontmatter).
   Invoke from the chat box with /name [args], or the model calls use_skill.
   The app ships none: every skill here is one the user wrote or imported. System commands
   (js/commands.js) share the /name syntax and are matched first, so a skill cannot shadow one.
   The model can write skills too (skill_write / skill_delete). Those writes, and only those,
   leave a previous version behind so Settings > Skills can put one back. */
H.skills = (() => {
  const KEY = 'harness.skills.v1';
  const PREV_KEY = 'harness.skills.prev.v1';
  const MAX_PREV = 30;
  let skills = H.tryJSON(localStorage.getItem(KEY), null) || [];
  let prev = H.tryJSON(localStorage.getItem(PREV_KEY), null) || {};   // name -> { at, skill: skill|null }; null = did not exist
  const save = () => { H.store.write(KEY, skills); H.bus.emit('skills', skills); };
  const savePrev = () => { H.store.write(PREV_KEY, prev); };

  /* parse "---\nname: x\ndescription: y\n---\nbody" */
  function parse(md, fallbackName) {
    const m = md.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
    const s = { name: fallbackName || 'skill', description: '', content: md };
    if (m) {
      for (const line of m[1].split('\n')) { const i = line.indexOf(':'); if (i > 0) s[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, ''); }
      s.content = m[2].trim();
    }
    s.name = String(s.name).toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
    return s;
  }
  const serialize = (s) => `---\nname: ${s.name}\ndescription: ${s.description}\n---\n${s.content}\n`;

  /* One rule for every caller (the editor, the import, the model's skill_write): kebab-case, non-empty,
     and never the name of a system command — such a skill could never be reached from the chat box. */
  function validate(raw) {
    const name = String(raw || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!name) return { ok: false, name, error: 'A skill needs a name (letters, digits, - and _).' };
    if (H.commands.get(name)) return { ok: false, name, error: `/${name} is a system command, so a skill by that name could never be reached. Pick another name.` };
    return { ok: true, name, error: null };
  }

  /* remember what a name held before the model touched it (null records "there was nothing here") */
  function snapshot(name) {
    prev[name] = { at: Date.now(), skill: skills.find(s => s.name === name) ? H.deepClone(skills.find(s => s.name === name)) : null };
    const names = Object.keys(prev).sort((a, b) => prev[a].at - prev[b].at);
    while (names.length > MAX_PREV) delete prev[names.shift()];
    savePrev();
  }
  const forgetPrev = (name) => { if (name in prev) { delete prev[name]; savePrev(); } };

  return {
    list: () => skills,
    get: (name) => skills.find(s => s.name === name),
    /* opts.by === 'model': keep the previous version so the user can undo it */
    upsert: (s, opts = {}) => {
      if (opts.by === 'model') snapshot(s.name); else forgetPrev(s.name);
      const i = skills.findIndex(x => x.name === s.name); if (i >= 0) skills[i] = s; else skills.push(s);
      save();
    },
    remove: (name, opts = {}) => {
      if (opts.by === 'model') snapshot(name); else forgetPrev(name);
      skills = skills.filter(s => s.name !== name); save();
    },
    /* the version a name held before the model last wrote it, or null when the model never did */
    prevOf: (name) => (name in prev ? prev[name] : null),
    /* put that version back (and drop the record: there is nothing left to undo) */
    revert: (name) => {
      const p = prev[name]; if (!p) return false;
      skills = skills.filter(s => s.name !== name);
      if (p.skill) skills.push(p.skill);
      forgetPrev(name); save();
      return true;
    },
    parse, serialize, validate,
    /* Expand "/name rest of message" into a message that carries the skill instructions */
    expandSlash: (text) => {
      const m = text.match(/^\/([a-z0-9_-]+)\s*([\s\S]*)$/i);
      if (!m) return null;
      const s = skills.find(x => x.name === m[1].toLowerCase());
      if (!s) return null;
      return { skill: s, display: text, content: `<skill name="${s.name}">\n${s.content}\n</skill>\n\n${m[2] ? 'User input: ' + m[2] : 'Follow the skill instructions above.'}` };
    },
    promptSection: () => '\n\n# Skills\n'
      + (skills.length
        ? `The following skills are available. When a request matches one, call use_skill to load its instructions, then follow them.\n` + skills.map(s => `- ${s.name}: ${s.description}`).join('\n') + '\n'
        : 'No skills are saved yet.\n')
      + `When the user asks you to make, change or remove a skill, do it with skill_write / skill_delete rather than printing markdown for them to paste. The name is what they will type as /name in the chat box, so keep it short and kebab-case; the description is what you will see when deciding whether to load it later. Read a skill with use_skill before rewriting it.`,
  };
})();
