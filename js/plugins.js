/* Plugin engine.
   Two plugin kinds:
   - 'rest': declarative manifest -> each tool maps to an HTTP request (templated with {{param}}).
   - 'mcp' : remote MCP server over Streamable HTTP (JSON-RPC: initialize / tools/list / tools/call).
   Plugins are stored in localStorage; built-in Jira & GitHub manifests ship as templates. */
H.plugins = (() => {
  const KEY = 'harness.plugins.v1';
  const mcpCache = new Map(); // id -> { sessionId, tools }
  const SECRET_HEADERS = /authorization|token|key|secret|cookie/i;
  /* secrets (auth + sensitive headers) live in H.secrets, never in the plugin JSON */
  const splitSecrets = (p) => {
    const pub = H.deepClone(p); const sec = {};
    if (pub.auth) { sec.auth = pub.auth; pub.auth = { type: pub.auth.type || 'none' }; }
    if (pub.headers) { for (const k of Object.keys(pub.headers)) if (SECRET_HEADERS.test(k)) { (sec.headers ||= {})[k] = pub.headers[k]; pub.headers[k] = '<secret>'; } }
    return { pub, sec };
  };
  const mergeSecrets = (pub) => { const sec = H.tryJSON(H.secrets.get('plugin:' + pub.id), {}); const p = H.deepClone(pub); if (sec.auth) p.auth = sec.auth; if (sec.headers) p.headers = { ...(p.headers || {}), ...sec.headers }; return p; };
  let plugins = (H.tryJSON(localStorage.getItem(KEY), null) || []).map(mergeSecrets);
  let toolsVersion = 1;                                     // bumped whenever plugins or MCP tool lists change; declared before save() because first-run template setup calls save() during module init
  const invalidateTools = () => { toolsVersion++; };
  const save = () => {
    invalidateTools();
    const pubs = plugins.map(p => { const { pub, sec } = splitSecrets(p); H.secrets.set('plugin:' + p.id, Object.keys(sec).length ? JSON.stringify(sec) : ''); return pub; });
    H.store.write(KEY, pubs); H.bus.emit('plugins', plugins);
  };

  /* ----------------------------- BUILT-IN TEMPLATES ----------------------------- */
  const P = (props, required = []) => ({ type: 'object', properties: props, required });
  const S = (d, e) => ({ type: 'string', description: d, ...(e || {}) });
  const N = (d) => ({ type: 'number', description: d });

  const JIRA = {
    id: 'jira', name: 'Jira', kind: 'rest', enabled: false,
    description: 'Atlassian Jira Cloud REST API v3 (search, read, create, update, comment, transition issues).',
    baseUrl: 'https://your-domain.atlassian.net',
    auth: { type: 'none' }, route: { type: 'bridge' },
    headers: { 'Accept': 'application/json' },
    guide: `Jira workflow (tool names start with {id}__):
- Issue keys look like PROJ-123 (project key + number). From a URL …/browse/PROJ-123 the key is the last segment.
- Find issues with search_issues + JQL. Examples: \`assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC\`, \`project = PROJ AND status = "In Progress"\`, \`text ~ "login bug"\`, \`key in (PROJ-1, PROJ-2)\`, \`sprint in openSprints() AND project = PROJ\`. Quote values containing spaces. Start with maxResults 20.
- Read one issue with get_issue (description, comments, status). Do not use search_issues for details you already have.
- Change status: get_transitions for the issue → pick the transition whose target matches → transition_issue with that id. Ids differ per project; never guess them.
- Assign: search_users (name or email) → accountId (Cloud) or username (Server) → assign_issue.
- Create: create_issue needs project key, summary, issueType (Task, Bug, Story…). Unknown project key → list_projects.
- Comments: add_comment with plain text. Keep comments concise; confirm wording with the user for anything customer-facing.
- Boards/sprints: list_boards (filter by project) → list_sprints(boardId) → issues via JQL \`sprint = <id>\` (or sprint_issues where available).
- Errors: 401/403 = credentials or permissions: stop and tell the user, do not retry. 404 = wrong key/project: verify with search_issues once, do not repeat the same call. Empty JQL result: broaden the query once (drop a filter), then report what you tried.`,
    notes: 'Jira Cloud: create an API token at https://id.atlassian.com/manage-profile/security/api-tokens. Jira Cloud does not send CORS headers, so set a CORS proxy in Settings > Web (or use a browser extension that adds CORS headers) when running from the browser. Jira Data Center: use auth type "bearer" with a PAT.',
    tools: [
      { name: 'search_issues', risk: 'safe', description: 'Search issues with JQL, e.g. `project = PROJ AND status != Done ORDER BY updated DESC`, `assignee = currentUser() AND resolution = Unresolved`, `key = PROJ-123`. Returns key, summary, status, assignee, priority, updated.', parameters: P({ jql: S('JQL query, e.g. project = ABC AND status != Done ORDER BY updated DESC'), maxResults: N('Max results (default 20)'), fields: S('Comma-separated fields (default summary,status,assignee,priority,updated,issuetype)') }, ['jql']),
        request: { method: 'GET', path: '/rest/api/3/search/jql', query: { jql: '{{jql}}', maxResults: '{{maxResults}}', fields: '{{fields}}' } }, defaults: { maxResults: 20, fields: 'summary,status,assignee,priority,updated,issuetype' },
        transform: 'data.issues ? data.issues.map(i => ({ key: i.key, summary: i.fields.summary, status: i.fields.status?.name, assignee: i.fields.assignee?.displayName, priority: i.fields.priority?.name, type: i.fields.issuetype?.name, updated: i.fields.updated })) : data' },
      { name: 'get_issue', risk: 'safe', description: 'Get full details of an issue (description, comments, status, links).', parameters: P({ key: S('Issue key, e.g. ABC-123') }, ['key']),
        request: { method: 'GET', path: '/rest/api/3/issue/{{key}}', query: { expand: 'renderedFields' } },
        transform: '({ key: data.key, summary: data.fields.summary, status: data.fields.status?.name, assignee: data.fields.assignee?.displayName, reporter: data.fields.reporter?.displayName, priority: data.fields.priority?.name, type: data.fields.issuetype?.name, labels: data.fields.labels, created: data.fields.created, updated: data.fields.updated, description: data.renderedFields?.description || data.fields.description, comments: (data.fields.comment?.comments||[]).map(c => ({ author: c.author?.displayName, created: c.created, body: c.body })), subtasks: (data.fields.subtasks||[]).map(s => s.key + " " + s.fields.summary), links: (data.fields.issuelinks||[]).map(l => l.type.name + ": " + (l.outwardIssue||l.inwardIssue)?.key) })' },
      { name: 'create_issue', risk: 'write', description: 'Create a new issue.', parameters: P({ project: S('Project key'), summary: S('Summary/title'), description: S('Plain-text description'), issueType: S('Issue type name (default Task)'), priority: S('Priority name (optional)'), labels: { type: 'array', items: { type: 'string' } }, assigneeAccountId: S('Assignee account id (optional)') }, ['project', 'summary']),
        request: { method: 'POST', path: '/rest/api/3/issue', body: { fields: { project: { key: '{{project}}' }, summary: '{{summary}}', issuetype: { name: '{{issueType}}' }, description: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: '{{description}}' }] }] }, priority: { name: '{{priority}}' }, labels: '{{json labels}}', assignee: { id: '{{assigneeAccountId}}' } } } }, defaults: { issueType: 'Task', description: ' ' } },
      { name: 'update_issue', risk: 'write', description: 'Update fields of an issue (summary, description, priority, labels, assignee).', parameters: P({ key: S('Issue key'), summary: S('New summary'), description: S('New plain-text description'), priority: S('Priority name'), labels: { type: 'array', items: { type: 'string' } }, assigneeAccountId: S('Assignee account id') }, ['key']),
        request: { method: 'PUT', path: '/rest/api/3/issue/{{key}}', body: { fields: { summary: '{{summary}}', description: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: '{{description}}' }] }] }, priority: { name: '{{priority}}' }, labels: '{{json labels}}', assignee: { id: '{{assigneeAccountId}}' } } }, pruneEmpty: true } },
      { name: 'add_comment', risk: 'write', description: 'Add a comment to an issue.', parameters: P({ key: S('Issue key'), body: S('Comment text') }, ['key', 'body']),
        request: { method: 'POST', path: '/rest/api/3/issue/{{key}}/comment', body: { body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: '{{body}}' }] }] } } } },
      { name: 'get_transitions', risk: 'safe', description: 'List available workflow transitions for an issue.', parameters: P({ key: S('Issue key') }, ['key']),
        request: { method: 'GET', path: '/rest/api/3/issue/{{key}}/transitions' }, transform: 'data.transitions.map(t => ({ id: t.id, name: t.name, to: t.to?.name }))' },
      { name: 'transition_issue', risk: 'write', description: 'Move an issue to another status. Call get_transitions first and pick the id whose target status matches; ids differ per project.', parameters: P({ key: S('Issue key'), transitionId: S('Transition id') }, ['key', 'transitionId']),
        request: { method: 'POST', path: '/rest/api/3/issue/{{key}}/transitions', body: { transition: { id: '{{transitionId}}' } } } },
      { name: 'assign_issue', risk: 'write', description: 'Assign an issue to a user by accountId (use search_users to find it). Pass null to unassign.', parameters: P({ key: S('Issue key'), accountId: S('Account id') }, ['key']),
        request: { method: 'PUT', path: '/rest/api/3/issue/{{key}}/assignee', body: { accountId: '{{accountId}}' } } },
      { name: 'list_projects', risk: 'safe', description: 'List Jira projects visible to the user.', parameters: P({ query: S('Filter by name/key (optional)') }),
        request: { method: 'GET', path: '/rest/api/3/project/search', query: { query: '{{query}}', maxResults: 50 } }, transform: 'data.values.map(p => ({ key: p.key, name: p.name, type: p.projectTypeKey, lead: p.lead?.displayName }))' },
      { name: 'search_users', risk: 'safe', description: 'Find users by name or email to get their accountId.', parameters: P({ query: S('Name or email') }, ['query']),
        request: { method: 'GET', path: '/rest/api/3/user/search', query: { query: '{{query}}' } }, transform: 'data.map(u => ({ accountId: u.accountId, displayName: u.displayName, email: u.emailAddress, active: u.active }))' },
      { name: 'myself', risk: 'safe', description: 'Get the current authenticated Jira user.', parameters: P({}), request: { method: 'GET', path: '/rest/api/3/myself' }, transform: '({ accountId: data.accountId, displayName: data.displayName, email: data.emailAddress })' },
      { name: 'list_sprints', risk: 'safe', description: 'List sprints of a board (Jira Software).', parameters: P({ boardId: N('Board id'), state: S('active | future | closed') }, ['boardId']),
        request: { method: 'GET', path: '/rest/agile/1.0/board/{{boardId}}/sprint', query: { state: '{{state}}' } }, transform: 'data.values.map(s => ({ id: s.id, name: s.name, state: s.state, start: s.startDate, end: s.endDate }))' },
      { name: 'list_boards', risk: 'safe', description: 'List agile boards, optionally filtered by project key.', parameters: P({ projectKeyOrId: S('Project key (optional)') }),
        request: { method: 'GET', path: '/rest/agile/1.0/board', query: { projectKeyOrId: '{{projectKeyOrId}}' } }, transform: 'data.values.map(b => ({ id: b.id, name: b.name, type: b.type }))' },
    ],
  };

  const GITHUB = {
    id: 'git', name: 'Git (GitHub)', kind: 'rest', enabled: false,
    description: 'Git hosting via GitHub REST API: repos, branches, commits, files, pull requests, issues. Set baseUrl to https://<host>/api/v3 for GitHub Enterprise.',
    baseUrl: 'https://api.github.com',
    auth: { type: 'bearer', token: '<personal access token>' },
    headers: { 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    guide: `GitHub workflow (tool names start with git__):
- Repositories are owner + repo (URL https://github.com/OWNER/REPO/…); PR and issue numbers follow /pull/ or /issues/.
- Explore: list_repos → get_repo (default branch) → list_dir / get_file (ref = branch). "Where is X" questions: search_code with \`repo:owner/name terms\`.
- History: list_commits (optionally path) → get_commit (diff); compare(base, head) for what changed between refs.
- Pull requests: list_pull_requests → get_pull_request → get_pull_request_diff or list_pr_files. Review with create_pr_review or add_pr_comment. merge_pull_request only when the user explicitly asks.
- Writing files: get_branch_sha(base) → create_branch → get_file (for the file sha when updating) → put_file (plain text content, include sha for updates) → create_pull_request. Never write to the default branch unless asked.
- Issues: list_issues → create_issue; add_pr_comment also works for issues.
- Errors: 401/403 = token missing or lacks scope: stop and tell the user. 404 = wrong owner/repo/branch or no access: verify with list_repos once, do not repeat. 422 on put_file usually means a missing or stale sha: get_file again.`,
    notes: 'GitHub API supports CORS, so this works directly from the browser. Create a fine-grained PAT at https://github.com/settings/tokens. For GitLab or Bitbucket, duplicate this plugin and adapt the paths.',
    tools: [
      { name: 'list_repos', risk: 'safe', description: 'List repositories of the authenticated user or an org.', parameters: P({ org: S('Organization (optional; default = your repos)'), perPage: N('Per page (default 30)') }),
        request: { method: 'GET', path: '{{#org}}', query: { per_page: '{{perPage}}', sort: 'updated' } }, defaults: { perPage: 30 },
        pathFn: 'a => a.org ? `/orgs/${a.org}/repos` : "/user/repos"', transform: 'data.map(r => ({ full_name: r.full_name, private: r.private, default_branch: r.default_branch, updated: r.updated_at, description: r.description }))' },
      { name: 'get_repo', risk: 'safe', description: 'Get repository metadata.', parameters: P({ owner: S('Owner'), repo: S('Repo') }, ['owner', 'repo']), request: { method: 'GET', path: '/repos/{{owner}}/{{repo}}' },
        transform: '({ full_name: data.full_name, description: data.description, default_branch: data.default_branch, stars: data.stargazers_count, open_issues: data.open_issues_count, language: data.language, url: data.html_url })' },
      { name: 'list_branches', risk: 'safe', description: 'List branches.', parameters: P({ owner: S('Owner'), repo: S('Repo') }, ['owner', 'repo']), request: { method: 'GET', path: '/repos/{{owner}}/{{repo}}/branches', query: { per_page: 100 } }, transform: 'data.map(b => ({ name: b.name, sha: b.commit.sha, protected: b.protected }))' },
      { name: 'create_branch', risk: 'write', description: 'Create a branch from another branch (or sha).', parameters: P({ owner: S('Owner'), repo: S('Repo'), branch: S('New branch name'), fromSha: S('Base commit sha (get via get_branch_sha)') }, ['owner', 'repo', 'branch', 'fromSha']),
        request: { method: 'POST', path: '/repos/{{owner}}/{{repo}}/git/refs', body: { ref: 'refs/heads/{{branch}}', sha: '{{fromSha}}' } } },
      { name: 'get_branch_sha', risk: 'safe', description: 'Get the head commit sha of a branch.', parameters: P({ owner: S('Owner'), repo: S('Repo'), branch: S('Branch') }, ['owner', 'repo', 'branch']), request: { method: 'GET', path: '/repos/{{owner}}/{{repo}}/git/ref/heads/{{branch}}' }, transform: '({ sha: data.object.sha })' },
      { name: 'list_commits', risk: 'safe', description: 'List recent commits on a branch or path.', parameters: P({ owner: S('Owner'), repo: S('Repo'), sha: S('Branch or sha (optional)'), path: S('Only commits touching this path (optional)'), perPage: N('Default 20') }, ['owner', 'repo']),
        request: { method: 'GET', path: '/repos/{{owner}}/{{repo}}/commits', query: { sha: '{{sha}}', path: '{{path}}', per_page: '{{perPage}}' } }, defaults: { perPage: 20 }, transform: 'data.map(c => ({ sha: c.sha.slice(0,7), message: c.commit.message.split("\\n")[0], author: c.commit.author.name, date: c.commit.author.date }))' },
      { name: 'get_commit', risk: 'safe', description: 'Get a commit with its diff stats and changed files.', parameters: P({ owner: S('Owner'), repo: S('Repo'), sha: S('Commit sha') }, ['owner', 'repo', 'sha']), request: { method: 'GET', path: '/repos/{{owner}}/{{repo}}/commits/{{sha}}' },
        transform: '({ sha: data.sha, message: data.commit.message, author: data.commit.author, stats: data.stats, files: data.files.map(f => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, patch: (f.patch||"").slice(0, 3000) })) })' },
      { name: 'get_file', risk: 'safe', description: 'Read a file from a repo (decoded text).', parameters: P({ owner: S('Owner'), repo: S('Repo'), path: S('File path'), ref: S('Branch/tag/sha (optional)') }, ['owner', 'repo', 'path']),
        request: { method: 'GET', path: '/repos/{{owner}}/{{repo}}/contents/{{path}}', query: { ref: '{{ref}}' } }, transform: 'Array.isArray(data) ? data.map(e => ({ path: e.path, type: e.type, size: e.size })) : ({ path: data.path, sha: data.sha, size: data.size, content: data.encoding === "base64" ? decodeURIComponent(escape(atob(data.content.replace(/\\n/g, "")))) : data.content })' },
      { name: 'list_dir', risk: 'safe', description: 'List a directory in a repo.', parameters: P({ owner: S('Owner'), repo: S('Repo'), path: S('Directory path (empty = root)'), ref: S('Branch (optional)') }, ['owner', 'repo']),
        request: { method: 'GET', path: '/repos/{{owner}}/{{repo}}/contents/{{path}}', query: { ref: '{{ref}}' } }, transform: '(Array.isArray(data) ? data : [data]).map(e => ({ path: e.path, type: e.type, size: e.size }))' },
      { name: 'put_file', risk: 'write', description: 'Create or update a file with a commit on a branch. Updating an existing file requires its current sha (call get_file first). Content is plain text (encoded automatically).', parameters: P({ owner: S('Owner'), repo: S('Repo'), path: S('File path'), content: S('New text content'), message: S('Commit message'), branch: S('Branch'), sha: S('Existing file sha (required for update)') }, ['owner', 'repo', 'path', 'content', 'message', 'branch']),
        request: { method: 'PUT', path: '/repos/{{owner}}/{{repo}}/contents/{{path}}', body: { message: '{{message}}', content: '{{content_b64}}', branch: '{{branch}}', sha: '{{sha}}' } }, prepare: 'a => ({ ...a, content_b64: btoa(unescape(encodeURIComponent(a.content))) })',
        transform: '({ commit: data.commit?.sha, path: data.content?.path, url: data.content?.html_url })' },
      { name: 'delete_file', risk: 'danger', description: 'Delete a file with a commit.', parameters: P({ owner: S('Owner'), repo: S('Repo'), path: S('File path'), message: S('Commit message'), branch: S('Branch'), sha: S('File sha') }, ['owner', 'repo', 'path', 'message', 'branch', 'sha']),
        request: { method: 'DELETE', path: '/repos/{{owner}}/{{repo}}/contents/{{path}}', body: { message: '{{message}}', branch: '{{branch}}', sha: '{{sha}}' } } },
      { name: 'search_code', risk: 'safe', description: 'Search code across GitHub, e.g. "repo:owner/name TODO language:python".', parameters: P({ q: S('Search query'), perPage: N('Default 20') }, ['q']),
        request: { method: 'GET', path: '/search/code', query: { q: '{{q}}', per_page: '{{perPage}}' } }, defaults: { perPage: 20 }, transform: '({ total: data.total_count, items: data.items.map(i => ({ repo: i.repository.full_name, path: i.path, url: i.html_url })) })' },
      { name: 'list_pull_requests', risk: 'safe', description: 'List pull requests.', parameters: P({ owner: S('Owner'), repo: S('Repo'), state: S('open | closed | all', { enum: ['open', 'closed', 'all'] }), perPage: N('Default 20') }, ['owner', 'repo']),
        request: { method: 'GET', path: '/repos/{{owner}}/{{repo}}/pulls', query: { state: '{{state}}', per_page: '{{perPage}}' } }, defaults: { state: 'open', perPage: 20 }, transform: 'data.map(p => ({ number: p.number, title: p.title, state: p.state, author: p.user.login, head: p.head.ref, base: p.base.ref, draft: p.draft, updated: p.updated_at, url: p.html_url }))' },
      { name: 'get_pull_request', risk: 'safe', description: 'Get a pull request with body and merge status.', parameters: P({ owner: S('Owner'), repo: S('Repo'), number: N('PR number') }, ['owner', 'repo', 'number']), request: { method: 'GET', path: '/repos/{{owner}}/{{repo}}/pulls/{{number}}' },
        transform: '({ number: data.number, title: data.title, body: data.body, state: data.state, merged: data.merged, mergeable: data.mergeable, author: data.user.login, head: data.head.ref, base: data.base.ref, additions: data.additions, deletions: data.deletions, changed_files: data.changed_files, url: data.html_url })' },
      { name: 'get_pull_request_diff', risk: 'safe', description: 'Get the unified diff of a pull request.', parameters: P({ owner: S('Owner'), repo: S('Repo'), number: N('PR number') }, ['owner', 'repo', 'number']),
        request: { method: 'GET', path: '/repos/{{owner}}/{{repo}}/pulls/{{number}}', headers: { 'Accept': 'application/vnd.github.diff' }, raw: true } },
      { name: 'list_pr_files', risk: 'safe', description: 'List files changed in a PR with patches.', parameters: P({ owner: S('Owner'), repo: S('Repo'), number: N('PR number') }, ['owner', 'repo', 'number']), request: { method: 'GET', path: '/repos/{{owner}}/{{repo}}/pulls/{{number}}/files', query: { per_page: 100 } },
        transform: 'data.map(f => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, patch: (f.patch||"").slice(0, 4000) }))' },
      { name: 'create_pull_request', risk: 'write', description: 'Open a pull request.', parameters: P({ owner: S('Owner'), repo: S('Repo'), title: S('Title'), head: S('Source branch'), base: S('Target branch'), body: S('Description (markdown)'), draft: { type: 'boolean' } }, ['owner', 'repo', 'title', 'head', 'base']),
        request: { method: 'POST', path: '/repos/{{owner}}/{{repo}}/pulls', body: { title: '{{title}}', head: '{{head}}', base: '{{base}}', body: '{{body}}', draft: '{{json draft}}' } }, transform: '({ number: data.number, url: data.html_url })' },
      { name: 'merge_pull_request', risk: 'danger', description: 'Merge a pull request.', parameters: P({ owner: S('Owner'), repo: S('Repo'), number: N('PR number'), method: S('merge | squash | rebase', { enum: ['merge', 'squash', 'rebase'] }), commitTitle: S('Commit title (optional)') }, ['owner', 'repo', 'number']),
        request: { method: 'PUT', path: '/repos/{{owner}}/{{repo}}/pulls/{{number}}/merge', body: { merge_method: '{{method}}', commit_title: '{{commitTitle}}' } }, defaults: { method: 'squash' } },
      { name: 'add_pr_comment', risk: 'write', description: 'Comment on a pull request or issue.', parameters: P({ owner: S('Owner'), repo: S('Repo'), number: N('PR/issue number'), body: S('Comment (markdown)') }, ['owner', 'repo', 'number', 'body']),
        request: { method: 'POST', path: '/repos/{{owner}}/{{repo}}/issues/{{number}}/comments', body: { body: '{{body}}' } }, transform: '({ id: data.id, url: data.html_url })' },
      { name: 'create_pr_review', risk: 'write', description: 'Submit a PR review (APPROVE / REQUEST_CHANGES / COMMENT).', parameters: P({ owner: S('Owner'), repo: S('Repo'), number: N('PR number'), event: S('APPROVE | REQUEST_CHANGES | COMMENT', { enum: ['APPROVE', 'REQUEST_CHANGES', 'COMMENT'] }), body: S('Review text') }, ['owner', 'repo', 'number', 'event']),
        request: { method: 'POST', path: '/repos/{{owner}}/{{repo}}/pulls/{{number}}/reviews', body: { event: '{{event}}', body: '{{body}}' } } },
      { name: 'list_issues', risk: 'safe', description: 'List issues (excludes PRs).', parameters: P({ owner: S('Owner'), repo: S('Repo'), state: S('open | closed | all'), labels: S('Comma-separated labels'), perPage: N('Default 20') }, ['owner', 'repo']),
        request: { method: 'GET', path: '/repos/{{owner}}/{{repo}}/issues', query: { state: '{{state}}', labels: '{{labels}}', per_page: '{{perPage}}' } }, defaults: { state: 'open', perPage: 20 }, transform: 'data.filter(i => !i.pull_request).map(i => ({ number: i.number, title: i.title, state: i.state, author: i.user.login, labels: i.labels.map(l => l.name), updated: i.updated_at, url: i.html_url }))' },
      { name: 'create_issue', risk: 'write', description: 'Create an issue.', parameters: P({ owner: S('Owner'), repo: S('Repo'), title: S('Title'), body: S('Body (markdown)'), labels: { type: 'array', items: { type: 'string' } } }, ['owner', 'repo', 'title']),
        request: { method: 'POST', path: '/repos/{{owner}}/{{repo}}/issues', body: { title: '{{title}}', body: '{{body}}', labels: '{{json labels}}' } }, transform: '({ number: data.number, url: data.html_url })' },
      { name: 'compare', risk: 'safe', description: 'Compare two refs (commits ahead/behind and changed files).', parameters: P({ owner: S('Owner'), repo: S('Repo'), base: S('Base ref'), head: S('Head ref') }, ['owner', 'repo', 'base', 'head']), request: { method: 'GET', path: '/repos/{{owner}}/{{repo}}/compare/{{base}}...{{head}}' },
        transform: '({ status: data.status, ahead_by: data.ahead_by, behind_by: data.behind_by, commits: data.commits.map(c => c.commit.message.split("\\n")[0]), files: data.files.map(f => f.filename + " (" + f.status + ")") })' },
      { name: 'list_workflow_runs', risk: 'safe', description: 'List recent GitHub Actions runs.', parameters: P({ owner: S('Owner'), repo: S('Repo'), branch: S('Branch (optional)'), perPage: N('Default 10') }, ['owner', 'repo']),
        request: { method: 'GET', path: '/repos/{{owner}}/{{repo}}/actions/runs', query: { branch: '{{branch}}', per_page: '{{perPage}}' } }, defaults: { perPage: 10 }, transform: 'data.workflow_runs.map(r => ({ id: r.id, name: r.name, status: r.status, conclusion: r.conclusion, branch: r.head_branch, created: r.created_at, url: r.html_url }))' },
      { name: 'whoami', risk: 'safe', description: 'Get the authenticated GitHub user.', parameters: P({}), request: { method: 'GET', path: '/user' }, transform: '({ login: data.login, name: data.name, email: data.email })' },
    ],
  };

  const MCP_EXAMPLE = { id: 'my-mcp', name: 'Remote MCP server', kind: 'mcp', enabled: false, description: 'Any MCP server exposed over Streamable HTTP.', url: 'https://example.com/mcp', headers: { 'Authorization': 'Bearer <token>' }, notes: 'The server must allow CORS from this page origin (or use a CORS proxy).' };
  /* LiteLLM MCP gateway: the proxy admin registers MCP servers (e.g. Atlassian's remote Jira MCP) and this page calls them with the LiteLLM key */
  const LITELLM_MCP = { id: 'litellm-mcp', name: 'LiteLLM MCP gateway', kind: 'mcp', enabled: false, useLitellmKey: true, description: 'MCP servers registered on your LiteLLM proxy (Jira, GitHub, Confluence…). Uses your LiteLLM API key, so no CORS problems and no extra credentials in the browser.', url: '', headers: {}, notes: 'Ask your LiteLLM admin to add MCP servers (LiteLLM UI → MCP Servers). Optionally restrict with the x-mcp-servers header, e.g. "jira,github".',
    setup: { urlLabel: 'MCP gateway URL', urlPlaceholder: '<LiteLLM base URL>/mcp/', urlHelp: 'Normally your LiteLLM base URL followed by /mcp/. Left empty, the LiteLLM base URL from Connection is used.', auth: [{ type: 'none', label: 'Use my LiteLLM API key (automatic)', fields: [] }], litellmDefault: true } };

  /* Jira Server / Data Center (REST API v2): plain-text descriptions, PAT or basic auth */
  const JIRA2 = {
    id: 'jira2', name: 'Jira Server / Data Center (API v2)', kind: 'rest', enabled: false,
    description: 'Jira Server / Data Center REST API v2 (also works with Jira Cloud v2 endpoints). Plain-text descriptions and comments.',
    baseUrl: 'https://jira.your-company.com',
    auth: { type: 'none' }, route: { type: 'bridge' },
    headers: { 'Accept': 'application/json', 'X-Atlassian-Token': 'no-check' },
    guide: `Jira workflow (tool names start with {id}__):
- Issue keys look like PROJ-123 (project key + number). From a URL …/browse/PROJ-123 the key is the last segment.
- Find issues with search_issues + JQL. Examples: \`assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC\`, \`project = PROJ AND status = "In Progress"\`, \`text ~ "login bug"\`, \`key in (PROJ-1, PROJ-2)\`, \`sprint in openSprints() AND project = PROJ\`. Quote values containing spaces. Start with maxResults 20.
- Read one issue with get_issue (description, comments, status). Do not use search_issues for details you already have.
- Change status: get_transitions for the issue → pick the transition whose target matches → transition_issue with that id. Ids differ per project; never guess them.
- Assign: search_users (name or email) → accountId (Cloud) or username (Server) → assign_issue.
- Create: create_issue needs project key, summary, issueType (Task, Bug, Story…). Unknown project key → list_projects.
- Comments: add_comment with plain text. Keep comments concise; confirm wording with the user for anything customer-facing.
- Boards/sprints: list_boards (filter by project) → list_sprints(boardId) → issues via JQL \`sprint = <id>\` (or sprint_issues where available).
- Errors: 401/403 = credentials or permissions: stop and tell the user, do not retry. 404 = wrong key/project: verify with search_issues once, do not repeat the same call. Empty JQL result: broaden the query once (drop a filter), then report what you tried.`,
    notes: 'Direct REST calls work once a Jira administrator adds this page\'s origin to Jira\'s Allowlist (Administration → System → Allowlist, "Allow incoming"). Requires Jira 8.9+ for preflight support.',
    setup: {
      urlLabel: 'Jira base URL', urlPlaceholder: 'https://jira.your-company.com', urlHelp: 'The address you open Jira at, without a trailing path.',
      warning: 'Jira Server / Data Center allows cross-origin REST calls only from origins on its Allowlist. Ask a Jira administrator to add this page\'s origin (' + (!/^https?:/.test(location.origin) ? 'you are opening the app via file:// which has no allowlistable origin: host it on an http(s) URL first' : location.origin) + ') under Administration → System → Allowlist with "Allow incoming" enabled. Until then requests fail with "Failed to fetch".',
      auth: [
        { type: 'bearer', label: 'Personal access token (Jira Server / Data Center 8.14+)', fields: [{ key: 'token', label: 'Personal access token', secret: true }], help: 'Create one under your profile → Personal Access Tokens.', link: '{{baseUrl}}/secure/ViewProfile.jspa?selectedTab=com.atlassian.pats.pats-plugin:jira-user-personal-access-tokens' },
        { type: 'basic', label: 'Username + password / API token', fields: [{ key: 'username', label: 'Username or email' }, { key: 'password', label: 'Password or API token', secret: true }], help: 'For Jira Cloud use your email and an API token.', link: 'https://id.atlassian.com/manage-profile/security/api-tokens' },
        { type: 'none', label: 'My browser login session (with the bridge route)', fields: [], help: 'No credentials stored: requests are made by your logged-in Jira tab.' },
      ],
      testTool: 'myself',
    },
    tools: [
      { name: 'search_issues', risk: 'safe', description: 'Search issues with JQL, e.g. `project = PROJ AND status != Done ORDER BY updated DESC`, `assignee = currentUser() AND resolution = Unresolved`, `key = PROJ-123`.', parameters: P({ jql: S('JQL query'), maxResults: N('Max results (default 20)'), fields: S('Comma-separated fields') }, ['jql']),
        request: { method: 'GET', path: '/rest/api/2/search', query: { jql: '{{jql}}', maxResults: '{{maxResults}}', fields: '{{fields}}' } }, defaults: { maxResults: 20, fields: 'summary,status,assignee,priority,updated,issuetype' },
        transform: '({ total: data.total, issues: (data.issues||[]).map(i => ({ key: i.key, summary: i.fields.summary, status: i.fields.status?.name, assignee: i.fields.assignee?.displayName, priority: i.fields.priority?.name, type: i.fields.issuetype?.name, updated: i.fields.updated })) })' },
      { name: 'get_issue', risk: 'safe', description: 'Get full details of an issue including description and comments.', parameters: P({ key: S('Issue key, e.g. ABC-123') }, ['key']),
        request: { method: 'GET', path: '/rest/api/2/issue/{{key}}' },
        transform: '({ key: data.key, summary: data.fields.summary, status: data.fields.status?.name, assignee: data.fields.assignee?.displayName, reporter: data.fields.reporter?.displayName, priority: data.fields.priority?.name, type: data.fields.issuetype?.name, labels: data.fields.labels, created: data.fields.created, updated: data.fields.updated, description: data.fields.description, comments: (data.fields.comment?.comments||[]).map(c => ({ author: c.author?.displayName, created: c.created, body: c.body })), subtasks: (data.fields.subtasks||[]).map(s => s.key + " " + s.fields.summary) })' },
      { name: 'create_issue', risk: 'write', description: 'Create an issue.', parameters: P({ project: S('Project key'), summary: S('Summary'), description: S('Description (plain text / wiki markup)'), issueType: S('Issue type (default Task)'), priority: S('Priority name'), labels: { type: 'array', items: { type: 'string' } }, assignee: S('Assignee username (Server) or accountId (Cloud)') }, ['project', 'summary']),
        request: { method: 'POST', path: '/rest/api/2/issue', body: { fields: { project: { key: '{{project}}' }, summary: '{{summary}}', description: '{{description}}', issuetype: { name: '{{issueType}}' }, priority: { name: '{{priority}}' }, labels: '{{json labels}}', assignee: { name: '{{assignee}}' } } } }, defaults: { issueType: 'Task' }, transform: '({ key: data.key, id: data.id })' },
      { name: 'update_issue', risk: 'write', description: 'Update summary / description / priority / labels of an issue.', parameters: P({ key: S('Issue key'), summary: S('New summary'), description: S('New description'), priority: S('Priority name'), labels: { type: 'array', items: { type: 'string' } } }, ['key']),
        request: { method: 'PUT', path: '/rest/api/2/issue/{{key}}', body: { fields: { summary: '{{summary}}', description: '{{description}}', priority: { name: '{{priority}}' }, labels: '{{json labels}}' } } } },
      { name: 'add_comment', risk: 'write', description: 'Add a comment.', parameters: P({ key: S('Issue key'), body: S('Comment text') }, ['key', 'body']), request: { method: 'POST', path: '/rest/api/2/issue/{{key}}/comment', body: { body: '{{body}}' } }, transform: '({ id: data.id, created: data.created })' },
      { name: 'get_transitions', risk: 'safe', description: 'List available workflow transitions.', parameters: P({ key: S('Issue key') }, ['key']), request: { method: 'GET', path: '/rest/api/2/issue/{{key}}/transitions' }, transform: 'data.transitions.map(t => ({ id: t.id, name: t.name, to: t.to?.name }))' },
      { name: 'transition_issue', risk: 'write', description: 'Move an issue to another status. Call get_transitions first and pick the id whose target status matches; ids differ per project.', parameters: P({ key: S('Issue key'), transitionId: S('Transition id'), comment: S('Optional comment') }, ['key', 'transitionId']),
        request: { method: 'POST', path: '/rest/api/2/issue/{{key}}/transitions', body: { transition: { id: '{{transitionId}}' }, update: { comment: [{ add: { body: '{{comment}}' } }] } } } },
      { name: 'assign_issue', risk: 'write', description: 'Assign an issue (username on Server, accountId on Cloud).', parameters: P({ key: S('Issue key'), user: S('Username / accountId') }, ['key', 'user']), request: { method: 'PUT', path: '/rest/api/2/issue/{{key}}/assignee', body: { name: '{{user}}', accountId: '{{user}}' } } },
      { name: 'list_projects', risk: 'safe', description: 'List projects.', parameters: P({}), request: { method: 'GET', path: '/rest/api/2/project' }, transform: 'data.map(p => ({ key: p.key, name: p.name, type: p.projectTypeKey }))' },
      { name: 'search_users', risk: 'safe', description: 'Find users.', parameters: P({ query: S('Name, username or email') }, ['query']), request: { method: 'GET', path: '/rest/api/2/user/search', query: { username: '{{query}}', query: '{{query}}' } }, transform: 'data.map(u => ({ name: u.name, accountId: u.accountId, displayName: u.displayName, email: u.emailAddress }))' },
      { name: 'myself', risk: 'safe', description: 'Current user.', parameters: P({}), request: { method: 'GET', path: '/rest/api/2/myself' }, transform: '({ name: data.name, displayName: data.displayName, email: data.emailAddress })' },
      { name: 'list_boards', risk: 'safe', description: 'List agile boards.', parameters: P({ projectKeyOrId: S('Project key (optional)') }), request: { method: 'GET', path: '/rest/agile/1.0/board', query: { projectKeyOrId: '{{projectKeyOrId}}' } }, transform: 'data.values.map(b => ({ id: b.id, name: b.name, type: b.type }))' },
      { name: 'list_sprints', risk: 'safe', description: 'List sprints of a board.', parameters: P({ boardId: N('Board id'), state: S('active | future | closed') }, ['boardId']), request: { method: 'GET', path: '/rest/agile/1.0/board/{{boardId}}/sprint', query: { state: '{{state}}' } }, transform: 'data.values.map(s => ({ id: s.id, name: s.name, state: s.state, start: s.startDate, end: s.endDate }))' },
      { name: 'sprint_issues', risk: 'safe', description: 'Issues in a sprint.', parameters: P({ sprintId: N('Sprint id') }, ['sprintId']), request: { method: 'GET', path: '/rest/agile/1.0/sprint/{{sprintId}}/issue', query: { fields: 'summary,status,assignee' } }, transform: 'data.issues.map(i => ({ key: i.key, summary: i.fields.summary, status: i.fields.status?.name, assignee: i.fields.assignee?.displayName }))' },
    ],
  };
  JIRA.setup = {
    urlLabel: 'Jira Cloud site URL', urlPlaceholder: 'https://your-domain.atlassian.net', urlHelp: 'Your Atlassian site address.',
    auth: [{ type: 'none', label: 'My browser login session (with the bridge route)', fields: [], help: 'No credentials stored: requests are made by your logged-in Jira tab.' }, { type: 'basic', label: 'Email + API token', fields: [{ key: 'username', label: 'Atlassian account email' }, { key: 'password', label: 'API token', secret: true }], help: 'Create an API token in your Atlassian account security settings, then paste it here.', link: 'https://id.atlassian.com/manage-profile/security/api-tokens' }],
    testTool: 'myself',
    warning: 'Jira Cloud does not send CORS headers, so a web page cannot call it directly. Easiest: choose "Browser session bridge" in step 3 and "My browser login session" in step 2. Alternatives: LiteLLM pass-through or the LiteLLM MCP gateway plugin.',
  };
  GITHUB.setup = {
    urlLabel: 'API base URL', urlPlaceholder: 'https://api.github.com', urlHelp: 'Keep the default for github.com; for GitHub Enterprise use https://<host>/api/v3.',
    auth: [{ type: 'bearer', label: 'Personal access token', fields: [{ key: 'token', label: 'Token (fine-grained or classic)', secret: true }], help: 'Create a token with repo scope; fine-grained tokens can be limited to specific repositories.', link: 'https://github.com/settings/tokens' }],
    testTool: 'whoami',
  };
  const GITLAB = {
    id: 'gitlab', name: 'Git (GitLab)', kind: 'rest', enabled: false,
    description: 'GitLab REST API v4: projects, branches, files, commits, merge requests, issues, pipelines. Works with gitlab.com and self-hosted GitLab.',
    baseUrl: 'https://gitlab.com/api/v4', auth: { type: 'none' }, route: { type: 'bridge' }, headers: {},
    guide: `GitLab workflow (tool names start with gitlab__):
- projectId is the numeric id or the path "group/subgroup/project" (tools encode it). From https://gitlab.host/group/project/-/merge_requests/12 the project is "group/project" and the MR iid is 12.
- Explore: list_projects(search) → get_project → list_tree(path, ref) → get_file(path, ref). Global search: search(scope=blobs|issues|merge_requests, search=…).
- Merge requests: list_merge_requests(state) → get_merge_request(iid) → get_merge_request_changes → add_mr_note. merge_merge_request only when explicitly asked.
- Writing: create_branch(branch, ref) → put_file(path, branch, content, message, update=true if the file exists) → create_merge_request(source, target, title).
- Pipelines: list_pipelines(ref).
- Errors: 401 = token/session problem: stop and tell the user. 404 = wrong project path (check with list_projects once) or no access. Never repeat an identical failing call.`,
    notes: 'Recommended: the browser session bridge (click the bookmarklet on your logged-in GitLab tab). Alternatively a personal access token, if your GitLab allows cross-origin API calls from this page.',
    setup: {
      urlLabel: 'GitLab API base URL', urlPlaceholder: 'https://gitlab.com/api/v4', urlHelp: 'For self-hosted GitLab use https://<host>/api/v4.',
      auth: [
        { type: 'none', label: 'My browser login session (with the bridge route)', fields: [], help: 'No credentials stored: requests are made by your logged-in GitLab tab; the bridge adds the CSRF token GitLab needs for writes.' },
        { type: 'header', fixedName: 'PRIVATE-TOKEN', label: 'Personal access token', fields: [{ key: 'value', label: 'Token (scope: api or read_api)', secret: true }], help: 'Create a token under User settings → Access tokens.', link: 'https://gitlab.com/-/user_settings/personal_access_tokens' },
      ],
      testTool: 'whoami',
    },
    tools: [
      { name: 'whoami', risk: 'safe', description: 'Current GitLab user.', parameters: P({}), request: { method: 'GET', path: '/user' }, transform: '({ id: data.id, username: data.username, name: data.name })' },
      { name: 'list_projects', risk: 'safe', description: 'List projects you are a member of.', parameters: P({ search: S('Filter by name (optional)') }),
        request: { method: 'GET', path: '/projects', query: { membership: 'true', search: '{{search}}', per_page: 30, order_by: 'last_activity_at' } }, transform: 'data.map(p => ({ id: p.id, path: p.path_with_namespace, default_branch: p.default_branch, url: p.web_url }))' },
      { name: 'get_project', risk: 'safe', description: 'Project details. projectId = numeric id or URL-encoded path (group%2Fproject).', parameters: P({ projectId: S('Project id or encoded path') }, ['projectId']), request: { method: 'GET', path: '/projects/{{projectId_enc}}' }, prepare: 'a => ({ ...a, projectId_enc: /^\\d+$/.test(a.projectId) ? a.projectId : encodeURIComponent(a.projectId) })',
        transform: '({ id: data.id, path: data.path_with_namespace, description: data.description, default_branch: data.default_branch, url: data.web_url, stars: data.star_count, open_issues: data.open_issues_count })' },
      { name: 'list_branches', risk: 'safe', description: 'List branches.', parameters: P({ projectId: S('Project id or encoded path'), search: S('Filter (optional)') }, ['projectId']), request: { method: 'GET', path: '/projects/{{projectId_enc}}/repository/branches', query: { search: '{{search}}', per_page: 100 } }, prepare: 'a => ({ ...a, projectId_enc: /^\\d+$/.test(a.projectId) ? a.projectId : encodeURIComponent(a.projectId) })', transform: 'data.map(b => ({ name: b.name, sha: b.commit.short_id, protected: b.protected, default: b.default }))' },
      { name: 'create_branch', risk: 'write', description: 'Create a branch.', parameters: P({ projectId: S('Project id or encoded path'), branch: S('New branch name'), ref: S('Source branch or sha') }, ['projectId', 'branch', 'ref']), request: { method: 'POST', path: '/projects/{{projectId_enc}}/repository/branches', query: { branch: '{{branch}}', ref: '{{ref}}' } }, prepare: 'a => ({ ...a, projectId_enc: /^\\d+$/.test(a.projectId) ? a.projectId : encodeURIComponent(a.projectId) })', transform: '({ name: data.name, url: data.web_url })' },
      { name: 'list_tree', risk: 'safe', description: 'List files in a directory of the repository.', parameters: P({ projectId: S('Project id or encoded path'), path: S('Directory (empty = root)'), ref: S('Branch (default: default branch)'), recursive: { type: 'boolean' } }, ['projectId']), request: { method: 'GET', path: '/projects/{{projectId_enc}}/repository/tree', query: { path: '{{path}}', ref: '{{ref}}', recursive: '{{recursive}}', per_page: 100 } }, prepare: 'a => ({ ...a, projectId_enc: /^\\d+$/.test(a.projectId) ? a.projectId : encodeURIComponent(a.projectId) })', transform: 'data.map(e => ({ path: e.path, type: e.type }))' },
      { name: 'get_file', risk: 'safe', description: 'Read a file (raw text) at a ref.', parameters: P({ projectId: S('Project id or encoded path'), path: S('File path'), ref: S('Branch/tag/sha') }, ['projectId', 'path']), request: { method: 'GET', path: '/projects/{{projectId_enc}}/repository/files/{{path_enc}}/raw', query: { ref: '{{ref}}' }, raw: true }, defaults: { ref: 'main' }, prepare: 'a => ({ ...a, projectId_enc: /^\\d+$/.test(a.projectId) ? a.projectId : encodeURIComponent(a.projectId), path_enc: encodeURIComponent(a.path) })' },
      { name: 'put_file', risk: 'write', description: 'Create or update a file with a commit.', parameters: P({ projectId: S('Project id or encoded path'), path: S('File path'), branch: S('Branch'), content: S('New content'), message: S('Commit message'), update: { type: 'boolean', description: 'true to update an existing file, false to create' } }, ['projectId', 'path', 'branch', 'content', 'message']),
        request: { method: 'PUT', path: '/projects/{{projectId_enc}}/repository/files/{{path_enc}}', body: { branch: '{{branch}}', content: '{{content}}', commit_message: '{{message}}' } }, prepare: 'a => ({ ...a, projectId_enc: /^\\d+$/.test(a.projectId) ? a.projectId : encodeURIComponent(a.projectId), path_enc: encodeURIComponent(a.path) })', pathFn: 'a => `/projects/${a.projectId_enc}/repository/files/${a.path_enc}`', transform: '({ file: data.file_path, branch: data.branch })' },
      { name: 'list_commits', risk: 'safe', description: 'Recent commits on a branch.', parameters: P({ projectId: S('Project id or encoded path'), ref: S('Branch (optional)'), path: S('Only commits touching this path (optional)'), perPage: N('Default 20') }, ['projectId']), request: { method: 'GET', path: '/projects/{{projectId_enc}}/repository/commits', query: { ref_name: '{{ref}}', path: '{{path}}', per_page: '{{perPage}}' } }, defaults: { perPage: 20 }, prepare: 'a => ({ ...a, projectId_enc: /^\\d+$/.test(a.projectId) ? a.projectId : encodeURIComponent(a.projectId) })', transform: 'data.map(c => ({ sha: c.short_id, title: c.title, author: c.author_name, date: c.committed_date }))' },
      { name: 'get_commit_diff', risk: 'safe', description: 'Diff of a commit.', parameters: P({ projectId: S('Project id or encoded path'), sha: S('Commit sha') }, ['projectId', 'sha']), request: { method: 'GET', path: '/projects/{{projectId_enc}}/repository/commits/{{sha}}/diff' }, prepare: 'a => ({ ...a, projectId_enc: /^\\d+$/.test(a.projectId) ? a.projectId : encodeURIComponent(a.projectId) })', transform: 'data.map(d => ({ file: d.new_path, diff: (d.diff||"").slice(0, 4000) }))' },
      { name: 'list_merge_requests', risk: 'safe', description: 'List merge requests.', parameters: P({ projectId: S('Project id or encoded path'), state: S('opened | closed | merged | all', { enum: ['opened', 'closed', 'merged', 'all'] }) }, ['projectId']), request: { method: 'GET', path: '/projects/{{projectId_enc}}/merge_requests', query: { state: '{{state}}', per_page: 20 } }, defaults: { state: 'opened' }, prepare: 'a => ({ ...a, projectId_enc: /^\\d+$/.test(a.projectId) ? a.projectId : encodeURIComponent(a.projectId) })', transform: 'data.map(m => ({ iid: m.iid, title: m.title, author: m.author.username, source: m.source_branch, target: m.target_branch, state: m.state, draft: m.draft, url: m.web_url }))' },
      { name: 'get_merge_request', risk: 'safe', description: 'Merge request details.', parameters: P({ projectId: S('Project id or encoded path'), iid: N('MR iid') }, ['projectId', 'iid']), request: { method: 'GET', path: '/projects/{{projectId_enc}}/merge_requests/{{iid}}' }, prepare: 'a => ({ ...a, projectId_enc: /^\\d+$/.test(a.projectId) ? a.projectId : encodeURIComponent(a.projectId) })', transform: '({ iid: data.iid, title: data.title, description: data.description, state: data.state, author: data.author.username, source: data.source_branch, target: data.target_branch, merge_status: data.detailed_merge_status, url: data.web_url })' },
      { name: 'get_merge_request_changes', risk: 'safe', description: 'Files changed in a merge request with diffs.', parameters: P({ projectId: S('Project id or encoded path'), iid: N('MR iid') }, ['projectId', 'iid']), request: { method: 'GET', path: '/projects/{{projectId_enc}}/merge_requests/{{iid}}/diffs', query: { per_page: 100 } }, prepare: 'a => ({ ...a, projectId_enc: /^\\d+$/.test(a.projectId) ? a.projectId : encodeURIComponent(a.projectId) })', transform: 'data.map(d => ({ file: d.new_path, diff: (d.diff||"").slice(0, 4000) }))' },
      { name: 'create_merge_request', risk: 'write', description: 'Open a merge request.', parameters: P({ projectId: S('Project id or encoded path'), source: S('Source branch'), target: S('Target branch'), title: S('Title'), description: S('Description (markdown)') }, ['projectId', 'source', 'target', 'title']), request: { method: 'POST', path: '/projects/{{projectId_enc}}/merge_requests', body: { source_branch: '{{source}}', target_branch: '{{target}}', title: '{{title}}', description: '{{description}}' } }, prepare: 'a => ({ ...a, projectId_enc: /^\\d+$/.test(a.projectId) ? a.projectId : encodeURIComponent(a.projectId) })', transform: '({ iid: data.iid, url: data.web_url })' },
      { name: 'add_mr_note', risk: 'write', description: 'Comment on a merge request.', parameters: P({ projectId: S('Project id or encoded path'), iid: N('MR iid'), body: S('Comment (markdown)') }, ['projectId', 'iid', 'body']), request: { method: 'POST', path: '/projects/{{projectId_enc}}/merge_requests/{{iid}}/notes', body: { body: '{{body}}' } }, prepare: 'a => ({ ...a, projectId_enc: /^\\d+$/.test(a.projectId) ? a.projectId : encodeURIComponent(a.projectId) })', transform: '({ id: data.id })' },
      { name: 'merge_merge_request', risk: 'danger', description: 'Merge a merge request.', parameters: P({ projectId: S('Project id or encoded path'), iid: N('MR iid'), squash: { type: 'boolean' } }, ['projectId', 'iid']), request: { method: 'PUT', path: '/projects/{{projectId_enc}}/merge_requests/{{iid}}/merge', body: { squash: '{{json squash}}' } }, prepare: 'a => ({ ...a, projectId_enc: /^\\d+$/.test(a.projectId) ? a.projectId : encodeURIComponent(a.projectId) })', transform: '({ state: data.state, sha: data.merge_commit_sha })' },
      { name: 'list_issues', risk: 'safe', description: 'List project issues.', parameters: P({ projectId: S('Project id or encoded path'), state: S('opened | closed | all'), labels: S('Comma-separated labels'), search: S('Text search') }, ['projectId']), request: { method: 'GET', path: '/projects/{{projectId_enc}}/issues', query: { state: '{{state}}', labels: '{{labels}}', search: '{{search}}', per_page: 20 } }, defaults: { state: 'opened' }, prepare: 'a => ({ ...a, projectId_enc: /^\\d+$/.test(a.projectId) ? a.projectId : encodeURIComponent(a.projectId) })', transform: 'data.map(i => ({ iid: i.iid, title: i.title, state: i.state, author: i.author.username, labels: i.labels, url: i.web_url }))' },
      { name: 'create_issue', risk: 'write', description: 'Create an issue.', parameters: P({ projectId: S('Project id or encoded path'), title: S('Title'), description: S('Description (markdown)'), labels: S('Comma-separated labels') }, ['projectId', 'title']), request: { method: 'POST', path: '/projects/{{projectId_enc}}/issues', body: { title: '{{title}}', description: '{{description}}', labels: '{{labels}}' } }, prepare: 'a => ({ ...a, projectId_enc: /^\\d+$/.test(a.projectId) ? a.projectId : encodeURIComponent(a.projectId) })', transform: '({ iid: data.iid, url: data.web_url })' },
      { name: 'list_pipelines', risk: 'safe', description: 'Recent CI pipelines.', parameters: P({ projectId: S('Project id or encoded path'), ref: S('Branch (optional)') }, ['projectId']), request: { method: 'GET', path: '/projects/{{projectId_enc}}/pipelines', query: { ref: '{{ref}}', per_page: 10 } }, prepare: 'a => ({ ...a, projectId_enc: /^\\d+$/.test(a.projectId) ? a.projectId : encodeURIComponent(a.projectId) })', transform: 'data.map(p => ({ id: p.id, status: p.status, ref: p.ref, sha: p.sha.slice(0,7), created: p.created_at, url: p.web_url }))' },
      { name: 'search', risk: 'safe', description: 'Global search (scope: projects, issues, merge_requests, blobs).', parameters: P({ scope: S('projects | issues | merge_requests | blobs | commits', { enum: ['projects', 'issues', 'merge_requests', 'blobs', 'commits'] }), search: S('Query') }, ['scope', 'search']), request: { method: 'GET', path: '/search', query: { scope: '{{scope}}', search: '{{search}}', per_page: 20 } } },
    ],
  };
  const templates = { jira: JIRA, jira2: JIRA2, git: GITHUB, gitlab: GITLAB, mcp: MCP_EXAMPLE, litellmMcp: LITELLM_MCP };
  setTimeout(() => H.store.write('harness.migrated.bridge2', '1'), 3000);
  for (const p of plugins) {
    const t = Object.values(templates).find(x => x.id === p.id); if (!t) continue;
    p.setup = t.setup; p.notes = t.notes; p.guide = t.guide; p.headers = { ...(t.headers || {}), ...(p.headers || {}) };
    const real = (v) => !!v && !/^<.*>$/.test(v);
    const hasCreds = !!(p.auth && (real(p.auth.token) || real(p.auth.password) || real(p.auth.value)));
    if (!p.route && t.route && !hasCreds) { p.route = H.deepClone(t.route); p.auth = { type: 'none' }; }  // never set up: adopt the recommended route
    if (p.route?.type === 'extension' && !hasCreds && !H.ext?.available?.() && !localStorage.getItem('harness.migrated.bridge2')) p.route = { type: 'bridge' };  // 1.7: bridge is the default again (extension only if installed)
  }
  if (!plugins.length) { plugins = [H.deepClone(JIRA), H.deepClone(JIRA2), H.deepClone(GITHUB)]; save(); }
  else if (!plugins.find(p => p.id === 'jira2')) { plugins.splice(1, 0, H.deepClone(JIRA2)); save(); }
  if (!plugins.find(p => p.id === 'litellm-mcp')) { plugins.push(H.deepClone(LITELLM_MCP)); save(); }
  if (!plugins.find(p => p.id === 'gitlab')) { plugins.splice(plugins.findIndex(p => p.id === 'git') + 1, 0, H.deepClone(GITLAB)); save(); }
  /* Tokens left behind by plugins removed before remove() cleaned up after itself. One sweep, once. */
  { const ids = new Set(plugins.map(p => p.id)); for (const k of H.secrets.keys()) if (k.startsWith('plugin:') && !ids.has(k.slice(7))) H.secrets.del(k); }

  /* ----------------------------- REST EXECUTION ----------------------------- */
  function authHeaders(p) {
    const a = p.auth || {};
    if (a.type === 'bearer' && a.token) return { Authorization: 'Bearer ' + a.token };
    if (a.type === 'basic' && a.username) return { Authorization: 'Basic ' + btoa(unescape(encodeURIComponent(a.username + ':' + (a.password || '')))) };
    if (a.type === 'header' && a.name) return { [a.name]: a.value || '' };
    if (a.type === 'query') return {};
    return {};
  }
  const prune = (o) => { if (Array.isArray(o)) return o.map(prune); if (o && typeof o === 'object') { const r = {}; for (const [k, v] of Object.entries(o)) { const pv = prune(v); if (pv === undefined || pv === '' || pv === null || (typeof pv === 'object' && !Array.isArray(pv) && Object.keys(pv).length === 0)) continue; r[k] = pv; } return r; } return o; };

  /* Route resolution: direct | litellm (pass-through endpoint on the LiteLLM proxy) | proxy (user-provided CORS proxy) */
  function resolveRoute(p, fullUrl) {
    const r = p.route || { type: 'direct' };
    if (r.type === 'litellm') {
      const base = H.settings.get('baseUrl').replace(/\/+$/, '') + '/' + String(r.path || p.id).replace(/^\/+|\/+$/g, '');
      const target = (p.kind === 'mcp' ? p.url : p.baseUrl).replace(/\/+$/, '');
      return { url: base + fullUrl.slice(target.length), headers: { Authorization: 'Bearer ' + H.settings.apiKey(), 'x-litellm-api-key': H.settings.apiKey() }, dropAuth: !r.forwardAuth };
    }
    if (r.type === 'bridge') return { url: fullUrl, headers: {}, dropAuth: p.auth?.type === 'none' || !!r.useSession, bridge: true };
    if (r.type === 'extension') return { url: fullUrl, headers: {}, dropAuth: p.auth?.type === 'none', ext: true };
    if (r.type === 'proxy' && r.proxyUrl) {
      const pu = r.proxyUrl.includes('{url}') ? r.proxyUrl.replace('{url}', encodeURIComponent(fullUrl)) : r.proxyUrl + fullUrl;
      return { url: pu, headers: {}, dropAuth: false };
    }
    return { url: fullUrl, headers: {}, dropAuth: false };
  }
  function corsHelp(p, e, attempted) {
    const origin = !/^https?:/.test(location.origin) ? 'null (file://)' : location.origin;
    const via = p.route?.type === 'litellm' ? ' (routed through your LiteLLM proxy: is the pass-through endpoint configured?)' : p.route?.type === 'proxy' ? ' (via your CORS proxy)' : '';
    return `${p.name}: the browser could not reach ${attempted || (p.kind === 'mcp' ? p.url : p.baseUrl)}${via} (${e.message}). ` +
      `This is almost always CORS: the API does not allow requests from web pages at origin ${origin}. Browsers block this regardless of your token. ` +
      `Options (plugin setup, step 3): (1) the "Browser session bridge": log in to the site in a dedicated tab and click the bookmarklet there; (2) the connector browser extension if you are allowed to load extensions; (3) ask the API admin to allow origin ${origin}; (4) a LiteLLM pass-through or a CORS proxy you trust.`;
  }
  async function runRest(p, t, args) {
    let a = { ...(t.defaults || {}), ...args };
    if (t.prepare) a = await H.runtime.evalExpr('prepare', t.prepare, { args: a });          // sandboxed: manifests never run in the page
    const req = t.request;
    // values substituted into the path are percent-encoded (spaces, ?, #, &, %) but keep '/' so multi-segment values
    // such as file paths or branch names still address nested resources; values that are already encoded are left alone
    const encSeg = (v) => /%[0-9A-Fa-f]{2}/.test(v) ? v : encodeURIComponent(v).replace(/%2F/gi, '/');
    const pathArgs = Object.fromEntries(Object.entries(a).map(([k, v]) => [k, typeof v === 'string' ? encSeg(v) : v]));
    let path = t.pathFn ? await H.runtime.evalExpr('pathFn', t.pathFn, { args: pathArgs }) : H.template(req.path, pathArgs);
    const url = new URL(p.baseUrl.replace(/\/+$/, '') + (path.startsWith('/') ? path : '/' + path));
    for (const [k, v] of Object.entries(req.query || {})) { const val = H.template(String(v), a); if (val !== '') url.searchParams.set(k, val); }
    if (p.auth?.type === 'query' && p.auth.name) url.searchParams.set(p.auth.name, p.auth.value || '');
    const route = resolveRoute(p, url.toString());
    const headers = { ...(p.headers || {}), ...(route.dropAuth ? {} : authHeaders(p)), ...(req.headers || {}), ...route.headers };
    const init = { method: req.method || 'GET', headers };
    if (req.body !== undefined && init.method !== 'GET') {
      const body = prune(H.templateDeep(req.body, a));
      init.body = typeof body === 'string' ? body : JSON.stringify(body);
      headers['Content-Type'] ||= 'application/json';
    }
    let r;
    if (route.bridge) { const br = await H.bridge.fetch(route.url, { ...init, body: init.body }); r = { ok: br.ok, status: br.status, text: async () => br.body || '' }; }
    else if (route.ext) { const er = await H.ext.fetch(route.url, { ...init, body: init.body, credentials: p.auth?.type === 'none' ? 'include' : 'omit' }); r = { ok: er.ok, status: er.status, text: async () => er.body || '' }; }
    else { try { r = await H.tools.fetchWithProxy(route.url, init, { allowProxy: false }); } catch (e) { throw new Error(corsHelp(p, e, route.url)); } }
    const text = await r.text();
    if (!r.ok) {
      const hint = { 400: 'the request was rejected as malformed: check parameter values and formats', 401: 'not authenticated: the credentials/session are missing or expired (re-run the plugin setup, or re-login in the bridged tab)', 403: 'authenticated but not permitted: the account lacks rights for this action or a CSRF check failed', 404: 'not found: check the key/id/path and the base URL (context path?)', 405: 'method not allowed at this URL', 409: 'conflict: the resource changed or already exists', 422: 'validation failed: see the response body for the field errors', 429: 'rate limited: wait and retry later', 500: 'server error: retry once, then report it to the user', 502: 'bad gateway', 503: 'service unavailable: retry later' }[r.status] || '';
      throw new Error(`${p.name} ${t.name}: HTTP ${r.status}${hint ? ' (' + hint + ')' : ''}. Response: ${H.clamp(text, 1500)}`);
    }
    if (req.raw) return { status: r.status, body: H.clamp(text, 60000) };
    let data = H.tryJSON(text, text);
    if (t.transform) { try { data = await H.runtime.evalExpr('transform', t.transform, { data, args: a }); } catch (e) { return { warning: e.message, data }; } }
    return data;
  }

  /* ----------------------------- MCP CLIENT (Streamable HTTP) ----------------------------- */
  async function mcpRpc(p, method, params, sessionId, { notify = false } = {}) {
    const route = resolveRoute(p, p.url);
    const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', ...(p.headers || {}), ...route.headers };
    if (p.useLitellmKey) { headers['x-litellm-api-key'] = H.settings.apiKey(); headers['Authorization'] = 'Bearer ' + H.settings.apiKey(); }
    if (sessionId) headers['Mcp-Session-Id'] = sessionId;
    const body = JSON.stringify(notify ? { jsonrpc: '2.0', method, params: params || {} } : { jsonrpc: '2.0', id: H.uid(), method, params: params || {} });
    let r;
    if (route.bridge) { const br = await H.bridge.fetch(route.url, { method: 'POST', headers, body }); r = { ok: br.ok, status: br.status, headers: { get: (k) => br.headers?.[k.toLowerCase()] || null }, text: async () => br.body || '' }; }
    else if (route.ext) { const er = await H.ext.fetch(route.url, { method: 'POST', headers, body }); r = { ok: er.ok, status: er.status, headers: { get: (k) => er.headers?.[k.toLowerCase()] || null }, text: async () => er.body || '' }; }
    else { try { r = await H.tools.fetchWithProxy(route.url, { method: 'POST', headers, body }, { allowProxy: false }); } catch (e) { throw new Error(corsHelp(p, e, route.url)); } }
    if (notify) { await r.text().catch(() => ''); return { result: null, sessionId: r.headers.get('Mcp-Session-Id') || sessionId }; }   // notifications expect no JSON-RPC response
    if (!r.ok) throw new Error(`MCP ${p.name}: HTTP ${r.status} ${H.clamp(await r.text(), 800)}`);
    const sid = r.headers.get('Mcp-Session-Id') || sessionId;
    const ct = r.headers.get('content-type') || '';
    let msg;
    if (ct.includes('text/event-stream')) {
      const txt = await r.text();
      for (const line of txt.split('\n')) if (line.startsWith('data:')) { const j = H.tryJSON(line.slice(5).trim(), null); if (j && (j.result || j.error)) msg = j; }
    } else msg = H.tryJSON(await r.text(), null);
    if (!msg) return { result: null, sessionId: sid };
    if (msg.error) throw new Error(`MCP ${p.name}: ${msg.error.message || JSON.stringify(msg.error)}`);
    return { result: msg.result, sessionId: sid };
  }
  async function mcpConnect(p, force = false) {
    if (!force && mcpCache.has(p.id)) return mcpCache.get(p.id);
    if (p.useLitellmKey && !p.url) p = { ...p, url: H.settings.get('baseUrl').replace(/\/+$/, '') + '/mcp/' };
    const init = await mcpRpc(p, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'web-llm-harness', version: '1.0' } });
    const sid = init.sessionId;
    try { await mcpRpc(p, 'notifications/initialized', {}, sid, { notify: true }); } catch { }   // same route (LiteLLM key / bridge / extension) as every other call
    const tl = await mcpRpc(p, 'tools/list', {}, sid);
    const conn = { sessionId: sid, tools: tl.result?.tools || [], serverInfo: init.result?.serverInfo };
    mcpCache.set(p.id, conn);
    return conn;
  }
  async function runMcp(p, toolName, args) {
    if (p.useLitellmKey && !p.url) p = { ...p, url: H.settings.get('baseUrl').replace(/\/+$/, '') + '/mcp/' };
    const conn = await mcpConnect(p);
    const { result } = await mcpRpc(p, 'tools/call', { name: toolName, arguments: args || {} }, conn.sessionId);
    if (!result) return null;
    const parts = (result.content || []).map(c => c.type === 'text' ? c.text : c.type === 'image' ? `[image ${c.mimeType}]` : JSON.stringify(c));
    const out = parts.length === 1 ? H.tryJSON(parts[0], parts[0]) : parts;
    if (result.isError) throw new Error(typeof out === 'string' ? out : JSON.stringify(out));
    return result.structuredContent || out;
  }

  /* ----------------------------- TOOL PROJECTION ----------------------------- */
  const cachedTools = { key: '', list: [] };
  function tools() {
    const key = toolsVersion;
    if (cachedTools.key === key) return cachedTools.list;
    const list = [];
    for (const p of plugins) {
      if (p.kind === 'rest') for (const t of p.tools || []) list.push({ name: `${p.id}__${t.name}`, group: 'Plugin: ' + p.name, plugin: p.id, risk: t.risk || 'write', description: `[${p.name}] ${t.description}`, parameters: t.parameters || { type: 'object', properties: {} }, run: (args) => runRest(p, t, args) });
      if (p.kind === 'mcp') for (const t of mcpCache.get(p.id)?.tools || []) list.push({ name: `${p.id}__${t.name}`, group: 'Plugin: ' + p.name, plugin: p.id, risk: t.annotations?.readOnlyHint ? 'safe' : (t.annotations?.destructiveHint ? 'danger' : 'write'), description: `[${p.name}] ${t.description || ''}`, parameters: t.inputSchema || { type: 'object', properties: {} }, run: (args) => runMcp(p, t.name, args) });
    }
    cachedTools.key = key; cachedTools.list = list;
    return list;
  }

  async function connectEnabledMcp() {
    for (const p of plugins) if (p.kind === 'mcp' && p.enabled) { try { await mcpConnect(p, true); } catch (e) { H.toast(`MCP ${p.name}: ${e.message}`, 'error', 6000); } }
    invalidateTools(); H.bus.emit('plugins', plugins);
  }

  async function test(p) {
    if (p.kind === 'mcp') { const c = await mcpConnect(p, true); invalidateTools(); return `Connected: ${c.serverInfo?.name || 'server'} — ${c.tools.length} tools: ${c.tools.map(t => t.name).join(', ')}`; }
    const t = (p.tools || []).find(x => ['myself', 'whoami', 'ping', 'list_projects', 'list_repos'].includes(x.name)) || (p.tools || [])[0];
    if (!t) return 'No tools defined.';
    const r = await runRest(p, t, {});
    return `${t.name} OK: ${H.clamp(JSON.stringify(r), 400)}`;
  }

  /* try to create a pass-through endpoint on the LiteLLM proxy with the user's key (works only if the key has admin rights) */
  async function createPassThrough(p, path) {
    const base = H.settings.get('baseUrl').replace(/\/+$/, '');
    const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + H.settings.apiKey() };
    const target = (p.baseUrl || '').replace(/\/+$/, '');
    /* "<secret>" is the placeholder an export leaves behind as a header *value*; forwarding it would store the
       literal string on the proxy as if it were a credential, so redacted headers are dropped and called out */
    const fwd = { ...(p.headers || {}), ...authHeaders(p) };
    const redacted = Object.keys(fwd).filter(k => fwd[k] === '<secret>');
    for (const k of redacted) delete fwd[k];
    if (redacted.length) throw new Error(`This plugin still has placeholder credentials for ${redacted.join(', ')} — it was set up from an exported manifest, which never carries secrets. Fill them in (step 2) before creating the pass-through endpoint.`);
    const body = { path: '/' + path, target, headers: fwd };
    const r = await fetch(base + '/config/pass_through_endpoint', { method: 'POST', headers, body: JSON.stringify(body) });
    const text = await r.text();
    if (r.status === 401 || r.status === 403) throw new Error('Your LiteLLM key is not allowed to create pass-through endpoints (admin rights needed). Ask the LiteLLM admin to add the YAML snippet.');
    if (!r.ok) throw new Error(`LiteLLM answered HTTP ${r.status}: ${H.clamp(text, 300)}`);
    return text;
  }

  /* usage guides of enabled plugins, for the system prompt */
  function promptSection() {
    const parts = plugins.filter(p => p.enabled && p.guide).map(p => p.guide.replace(/\{id\}/g, p.id));
    return parts.length ? '\n\n# Plugin guides\n' + parts.join('\n\n') : '';
  }

  return {
    createPassThrough, promptSection,
    list: () => plugins, get: (id) => plugins.find(p => p.id === id), templates,
    upsert: (p) => { const i = plugins.findIndex(x => x.id === p.id); if (i >= 0) plugins[i] = p; else plugins.push(p); mcpCache.delete(p.id); invalidateTools(); save(); },
    /* the credentials go with it: save() only rewrites secrets for the plugins that are left, so without this
       the token of a removed plugin would sit in storage for the life of the browser profile */
    remove: (id) => { plugins = plugins.filter(p => p.id !== id); mcpCache.delete(id); H.secrets.del('plugin:' + id); invalidateTools(); save(); },
    setEnabled: async (id, on) => { const p = plugins.find(x => x.id === id); if (!p) return; p.enabled = on; save(); if (on && p.kind === 'mcp') { try { await mcpConnect(p, true); invalidateTools(); H.bus.emit('plugins', plugins); } catch (e) { H.toast('MCP connect failed: ' + e.message, 'error', 6000); } } },
    tools, test, connectEnabledMcp,
    exportAll: () => JSON.stringify(plugins.map(p => splitSecrets(p).pub), null, 2),
    exportSafe: (p) => splitSecrets(p).pub,
    hasCode: (p) => (p.tools || []).some(t => t.transform || t.prepare || t.pathFn),
    importJSON: (json) => {
      const arr = [].concat(JSON.parse(json));
      for (const p of arr) if (!p.id || !p.kind) throw new Error('Plugin needs id and kind');
      const withCode = arr.filter(p => H.plugins.hasCode(p));
      if (withCode.length && !confirm(`The plugin manifest "${withCode.map(p => p.name || p.id).join(', ')}" contains code expressions (transform / prepare / pathFn). They run in a sandbox without access to your page, storage or secrets, but they shape the requests sent with your credentials. Only import manifests from sources you trust.\n\nImport anyway?`)) throw new Error('Import cancelled');
      for (const p of arr) H.plugins.upsert(p);
    },
  };
})();
