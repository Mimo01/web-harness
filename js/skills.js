/* Skills: reusable instruction sets (markdown with optional YAML-ish frontmatter).
   Invoke from the chat box with /name [args], or the model calls use_skill. */
H.skills = (() => {
  const KEY = 'harness.skills.v1';
  let skills = H.tryJSON(localStorage.getItem(KEY), null);
  const save = () => { localStorage.setItem(KEY, JSON.stringify(skills)); H.bus.emit('skills', skills); };

  const builtin = [
    { name: 'commit', description: 'Summarize workspace changes and write a conventional commit message.', content: `# Commit message skill
1. Use fs_search / fs_read to understand what changed (ask the user for a diff if unclear).
2. Write a Conventional Commits message: type(scope): subject (<= 72 chars), blank line, bullet body explaining WHY.
3. Output only the message in a code block.` },
    { name: 'review', description: 'Code-review a file or PR: bugs, security, readability, tests.', content: `# Code review skill
Review the given code (workspace file via fs_read, or a PR via git__get_pull_request_diff).
For each finding give: severity (blocker/major/minor/nit), file:line, problem, concrete fix.
Order by severity. End with a 2-line overall verdict. Do not restate the code.` },
    { name: 'jira-standup', description: 'Generate a standup summary from my Jira issues.', content: `# Jira standup skill
1. Call jira__myself to get my accountId.
2. jira__search_issues with JQL: assignee = currentUser() AND updated >= -2d ORDER BY updated DESC
3. Group into: Done yesterday / In progress today / Blocked. Keep each bullet to one line with the issue key.` },
    { name: 'research', description: 'Research a topic on the web and produce a cited summary.', content: `# Research skill
1. Run 2-4 web_search queries with different phrasings.
2. web_fetch the 3-5 most relevant sources.
3. Write a structured summary with inline citations [n] and a numbered source list with URLs. Flag disagreements between sources.` },
    { name: 'plan', description: 'Break a task into an implementation plan before coding.', content: `# Planning skill
Before writing any code: restate the goal, list assumptions, enumerate files to touch (use fs_list/fs_search), give numbered steps with acceptance criteria, list risks. Ask the user to confirm the plan before executing.` },
  ];
  if (!skills) { skills = H.deepClone(builtin); save(); }

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
    parse, serialize, builtin,
    resetBuiltin: () => { for (const b of builtin) if (!skills.find(s => s.name === b.name)) skills.push(H.deepClone(b)); save(); },
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
