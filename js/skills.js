/* Skills: reusable instruction sets (markdown with optional YAML-ish frontmatter).
   Invoke from the chat box with /name [args], or the model calls use_skill.
   The app ships none: every skill here is one the user wrote or imported. System commands
   (js/commands.js) share the /name syntax and are matched first, so a skill cannot shadow one. */
H.skills = (() => {
  const KEY = 'harness.skills.v1';
  let skills = H.tryJSON(localStorage.getItem(KEY), null) || [];
  const save = () => { localStorage.setItem(KEY, JSON.stringify(skills)); H.bus.emit('skills', skills); };

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

  return {
    list: () => skills,
    get: (name) => skills.find(s => s.name === name),
    upsert: (s) => { const i = skills.findIndex(x => x.name === s.name); if (i >= 0) skills[i] = s; else skills.push(s); save(); },
    remove: (name) => { skills = skills.filter(s => s.name !== name); save(); },
    parse, serialize,
    /* Expand "/name rest of message" into a message that carries the skill instructions */
    expandSlash: (text) => {
      const m = text.match(/^\/([a-z0-9_-]+)\s*([\s\S]*)$/i);
      if (!m) return null;
      const s = skills.find(x => x.name === m[1].toLowerCase());
      if (!s) return null;
      return { skill: s, display: text, content: `<skill name="${s.name}">\n${s.content}\n</skill>\n\n${m[2] ? 'User input: ' + m[2] : 'Follow the skill instructions above.'}` };
    },
    promptSection: () => skills.length ? `\n\n# Skills\nThe following skills are available. When a request matches one, call use_skill to load its instructions, then follow them.\n` + skills.map(s => `- ${s.name}: ${s.description}`).join('\n') : '',
  };
})();
