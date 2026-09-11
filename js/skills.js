/* Skills: reusable instruction sets (markdown with optional YAML-ish frontmatter).
   Invoke from the chat box with /name [args], or the model calls use_skill. */
H.skills = (() => {
  const KEY = 'harness.skills.v1';
  let skills = H.tryJSON(localStorage.getItem(KEY), null);
  const save = () => { localStorage.setItem(KEY, JSON.stringify(skills)); H.bus.emit('skills', skills); };

  const builtin = [
    { name: 'commit', description: 'Summarize the current changes and write a conventional commit message.', content: `# Commit message skill
1. git_status, then git_diff to see exactly what changed. In a folder that is not a repository use workspace_changes instead.
2. Group the changes by intent, not by file.
3. Write a Conventional Commits message: type(scope): subject (<= 72 chars), blank line, bullet body explaining WHY.
4. Output only the message in a code block. The harness cannot commit: tell the user to paste it.` },
    { name: 'review', description: 'Code-review a file or PR: bugs, security, readability, tests.', content: `# Code review skill
Review the given code (workspace file via fs_read, or a PR via git__get_pull_request_diff).
For each finding give: severity (blocker/major/minor/nit), file:line, problem, concrete fix.
Order by severity. End with a 2-line overall verdict. Do not restate the code.` },
    { name: 'review-diff', description: 'Review the uncommitted changes in the workspace.', content: `# Review my changes
1. git_status for the shape of the change, then git_diff for the patch (workspace_changes if this is not a repository).
2. For anything non-obvious, read the surrounding code (fs_read with a line range) before judging it — a diff hides its context.
3. Report per finding: severity (blocker/major/minor/nit), path:line, what is wrong, the concrete fix.
4. Call out what the change forgets: callers not updated (code_deps), tests, docs, error paths.
5. End with a two-line verdict. Do not restate the diff.` },
    { name: 'explain-repo', description: 'Explain what a project does and how it is put together.', content: `# Explain this codebase
1. project_overview first. Read the README head it returns.
2. From the entry points, follow the real path through the code: code_outline the main files, code_deps to see what connects to what, code_symbol for anything central.
3. git_log -n 15 to see what the project has been working on lately.
4. Write: what it does, how it is structured (name the directories), the main flow end to end, where state lives, how it is built/run/tested, and what looks unusual or risky.
Cite every claim as path/to/file.js:line. Do not guess: if something is unclear, read it.` },
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
  /* Built-ins added by a later release are merged in once. A built-in the user deleted stays deleted:
     SEEN remembers every built-in name this installation has already been offered. */
  const SEEN = 'harness.skills.seenBuiltin.v1';
  if (!skills) { skills = H.deepClone(builtin); localStorage.setItem(SEEN, JSON.stringify(builtin.map(b => b.name))); save(); }
  else {
    const seen = new Set(H.tryJSON(localStorage.getItem(SEEN), null) || skills.map(s => s.name));
    const fresh = builtin.filter(b => !seen.has(b.name));
    if (fresh.length) { skills.push(...H.deepClone(fresh)); save(); }
    localStorage.setItem(SEEN, JSON.stringify([...new Set([...seen, ...builtin.map(b => b.name)])]));
  }

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
