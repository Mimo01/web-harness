<h1 align="center">🧰 Web LLM Harness</h1>

<p align="center"><b>A full AI agent workbench that runs in a browser tab. Nothing to install. Nothing to host. Nothing leaves your machine except the requests you configure.</b></p>

<p align="center">
  <a href="https://github.com/Mimo01/web-harness/archive/refs/heads/main.zip"><img alt="Download" src="https://img.shields.io/badge/download-zip-0f7a72?style=for-the-badge"></a>
  <img alt="No install" src="https://img.shields.io/badge/install-none-3f9d6a?style=for-the-badge">
  <img alt="Runs on" src="https://img.shields.io/badge/runs%20on-Chrome%20%7C%20Edge%20%7C%20Firefox%20%7C%20Safari-555?style=for-the-badge">
  <img alt="Backend" src="https://img.shields.io/badge/backend-your%20LiteLLM%20proxy-555?style=for-the-badge">
  <a href="LICENSE"><img alt="License MIT" src="https://img.shields.io/badge/license-MIT-3f9d6a?style=for-the-badge"></a>
</p>

Point it at your **LiteLLM proxy** (or any OpenAI-compatible endpoint) and the model gets hands: it reads and edits
files in a folder you choose, runs Python and JavaScript, calls REST APIs, works your **Jira**, **GitHub** and
**GitLab**, follows reusable **skills**, and asks before doing anything risky. Locked-down laptop? That's the
whole point: it's a folder of static files. Double-click `index.html` and you're in.

## 🚀 Install

**1. Download** → [web-harness.zip](https://github.com/Mimo01/web-harness/archive/refs/heads/main.zip)
**2. Unzip** it anywhere (Desktop, Documents, a network share…). Rename the folder if you like.
**3. Open** `index.html` in Chrome or Edge (Firefox and Safari work too, without local-folder access).
**4. Connect**: Settings opens by itself. Paste your LiteLLM **base URL** (without `/v1`) and **API key**, click
*Test connection*, pick a model. Done.

<details>
<summary>Prefer a URL instead of a file? (recommended for the Jira/GitLab bridge)</summary>

Drop the folder on any static host you already have: an internal web server, SharePoint, GitHub Pages, S3,
Netlify. No build step, no configuration. If you happen to have Python: `python3 -m http.server 8765` and open
http://localhost:8765.
</details>

> **CORS note**: your browser talks to LiteLLM directly, so the proxy must allow your page origin. LiteLLM allows
> all origins by default; if yours is locked down, ask its admin to add your origin (or `null` for `file://`).

## 🔄 Update

The app checks this repository on startup and every hour. When a newer version exists you get a small notice
with a **Download** button (Settings → About → *Check for updates* does it on demand).

**To update**: download the zip again, unzip it **over your existing folder** (replace all files), reload the tab.
Your chats, settings, skills, plugins and credentials live in the browser, not in the folder, so nothing is lost.
Don't want the check? Turn it off in Settings → Security & privacy; it only ever fetches a public `version.json`.

## ✨ What you get

- **Chats** that stream, render markdown and code, remember everything locally, show tokens and cost per message.
- **Attach anything**: PDF, Word, PowerPoint, Excel/CSV, code and text files become text; images are resized and
  sent as vision input; videos become sampled frames plus a transcript; audio becomes a transcript (transcription
  uses a speech model on your proxy, e.g. whisper). All of it happens in the browser; nothing is uploaded elsewhere.
- **40+ built-in tools**: files, code execution (Python via Pyodide, JavaScript in a sandbox), web, data, memory.
- **Three chat modes**: *Default* asks before writes, *Allow all* just goes, *Plan* investigates read-only and
  hands you a plan with an **Execute** button.
- **Skills**: reusable playbooks you trigger with `/name` or the model picks up on its own.
- **Plugins**: Jira Cloud, Jira Server/Data Center, GitHub, GitLab out of the box, any REST API via a JSON manifest,
  and remote **MCP** servers.
- **Browser session bridge**: APIs that block browsers (Jira!) still work: a bookmarklet turns your logged-in tab
  into a relay. No admin, no proxy, no token. A connector extension is available where extensions are allowed.
- **Permissions you control**: per-tool allow / ask / deny, session grants, re-runnable tool cards.
- **Usage & costs**: context meter, per-chat and all-time totals, prices from LiteLLM or your own table.
- **Security first**: no backend, no telemetry, no third-party fetch services by default, secrets in a separate
  store you can keep session-only, sandboxed code and previews.

## 🧭 Quick tour

1. Click **Workspace** and pick a project folder. Ask: *"List the files and summarize what this project does."*
2. Switch to **Plan mode** and ask: *"Plan how to add unit tests."* Review the plan, hit **Execute**.
3. Type `/research` followed by a topic, or `/review` on a file, to use a skill.
4. Settings → **Plugins** → *Set up* Jira or GitLab, click the bookmarklet on your logged-in tab, then ask:
   *"What are my open issues? Group them by status."*

## 📚 Features in detail

### Chats
Multiple persisted conversations, streaming responses, markdown + syntax highlighting, reasoning traces
(when the model returns `reasoning_content`), token usage, regenerate, export to markdown, file/image attachments
(drag & drop or paste), auto-titles, dark/light theme.

### Tools (built in)
| Group | Tools |
|---|---|
| Documents & media | chat attachments, `fs_upload_from_user` and `fs_read` convert PDF (pdf.js), .docx / .pptx (JSZip + XML), .xlsx / .xls / .ods / .csv (SheetJS) to text, client-side. Images are downscaled (max 1600 px) and sent as vision input; `view_image` lets the model look at an image in the workspace. Videos: up to 6 sampled frames + transcript; audio: transcript (needs a transcription model set in Settings → Model). HEIC and legacy .doc/.ppt are reported as unsupported. |
| Files (workspace folder you pick) | `fs_list`, `fs_read`, `fs_write`, `fs_edit`, `fs_append`, `fs_mkdir`, `fs_delete`, `fs_move`, `fs_stat`, `fs_search` (grep), `fs_find` (glob), `fs_upload_from_user`, `download_file` |
| Code | `run_javascript` (sandboxed Web Worker), `run_python` (Pyodide, numpy/pandas etc.), `run_file` (.js/.py/.html/.json), `render_html` (preview panel), `calculate` |
| Web | `web_fetch` (direct, HTML → text), `web_search` (needs a configured provider), `http_request` (call any API), `open_url` |
| Data | `json_query`, `regex_extract`, `csv_parse`, `text_stats`, `base64`, `hash_text` |
| Memory | `memory_save`, `memory_get`, `memory_list`, `memory_delete` (persistent across chats) |
| Interaction | `ask_user` (the question appears in the chat; answer with a click or by typing in the message box), `notify_user`, `clipboard_write` |
| Utility | `get_datetime`, `sleep`, `browser_info` |
| Skills | `use_skill`, `list_skills` |
| Agent | `run_subagent` (fresh context, same tools) |

Click **📁 Workspace** to grant access to a local folder; file tools operate inside it (path traversal is blocked).
Browsers without the File System Access API fall back to an in-memory workspace.

### Chat modes & permissions
Pick a mode (and the model) in the pills under the message box; both apply to the chat you are in and to new chats:

| Mode | Behaviour |
|---|---|
| **Default** | `safe` (read-only) tools run silently; `write` / `danger` tools ask first. |
| **Allow all** | everything runs without prompts (explicit per-tool denies still apply). |
| **Plan** | the model may only use read-only tools. It investigates and writes a numbered plan. A **Plan ready** bar lets you execute it with default permissions or with allow-all; the mode returns to Default afterwards. |

Transient proxy errors (429, 5xx, dropped connections) are retried up to three times with backoff before a reply
is marked failed, and a failed reply has a Retry button; an error the proxy sends mid-stream is shown as an error, not
as an empty reply. A reply cut off at the output limit gets a Continue button. Stop cancels the request and any running
tool (JavaScript and Python workers are terminated, HTTP and bridge requests aborted). When the model issues several
read-only tool calls at once they run in parallel; anything that writes, asks, or needs a permission prompt runs one at
a time, in order. Keep one harness tab open per browser profile: a second tab gets a warning, because settings and
usage totals are shared.

Chats are stored in IndexedDB in three parts: a small index record per chat (title, time, search text, usage) that the
sidebar and startup read, the chat itself, and attached images in their own store, written once. Saving a tool result
rewrites the chat text but never its images; opening the app reads one index record to pick the newest chat.

The model also receives a short usage guide for each enabled plugin (issue-key formats, which call comes before
which, how to handle errors), and a loop guard blocks a tool call repeated with identical arguments and outcome
more than three times in one turn, then asks the model to report instead.

Per tool (Settings → Tools) you can disable it, or force `always allow` / `always ask` / `deny`. "Always ask, even for
safe tools" turns on strict mode. When prompted you can *Allow once*, *Allow for session*, *Always allow*, *Deny*
(optionally with a message the model sees) or *Never allow*.

### Re-running tools
Tool cards have a re-run button only where repeating the action is something you experience: open the URL again,
render the HTML preview again, run an HTML file again, download the file again, copy to the clipboard again, show the
notification again. Everything else (reads, searches, writes, API calls, computations) cannot be re-run from the card,
because the result would only be shown to you and never reach the model.

### Context management
Long chats stay within the model's window and costs stay roughly linear:
- **Tool result stubs**: tool outputs older than the last 2 user turns are sent as a short stub ("…truncated, re-run
  the tool for the full result"); the model is told it can re-fetch them.
- **Compaction**: when the context passes 70% of the window (both configurable in Settings → Model & generation), the
  older part of the conversation is summarised by the model and replaced, for the model, by that summary; the last 3
  turns stay verbatim. The chat itself keeps every message: compacted ones are greyed and a "compacted" card shows the
  summary. Run it by hand from the ⋯ menu ("Compact this chat").
- **Stable system prompt**: static rules, plugin guides and skills come first in a deterministic order; the workspace
  line and the date sit at the end, so proxies with prompt caching can reuse the long prefix between turns.

### Usage & costs
The message box shows the estimated context in use versus the model's window, and the chat's tokens and cost. Prices and
context sizes are read from LiteLLM's `/model/info` when the proxy exposes it; otherwise set them in
Settings → Usage & costs (USD per 1M tokens). The Usage section also shows all-time totals per model and per day.

### Skills
Skills are reusable markdown instruction sets. Type `/` in the chat box to pick one (`/review`, `/research`,
`/jira-standup`, …) or let the model load one itself through `use_skill` when a request matches its description.
Create/edit in **Settings → Skills**, or import `.md` files with frontmatter:

```md
---
name: my-skill
description: What it is for (the model sees this)
---
Instructions…
```

### Plugins (MCP-like)
Plugins add tools. Two kinds:

1. **REST plugins** — a JSON manifest declaring tools as HTTP calls. Shipped: **Jira Cloud (API v3)**,
   **Jira Server / Data Center (API v2)** (search JQL, get/create/update issue, comment, transitions, assign,
   projects, users, boards, sprints, sprint issues), **Git / GitHub** (repos, branches, commits, files, code search,
   pull requests + diffs + reviews + merge, issues, compare, Actions runs) and **Git / GitLab** (projects, branches,
   tree, files, commits, merge requests + diffs + notes + merge, issues, pipelines, search).
   Click **Set up** for a guided 3-step form (URL → auth method with a link to the token page → test connection),
   or *Edit manifest* to add tools:
   ```json
   { "name": "get_issue", "risk": "safe", "description": "…",
     "parameters": { "type": "object", "properties": { "key": { "type": "string" } }, "required": ["key"] },
     "request": { "method": "GET", "path": "/rest/api/3/issue/{{key}}", "query": {}, "headers": {}, "body": {} },
     "transform": "({ key: data.key, summary: data.fields.summary })" }
   ```
   `{{param}}` templates strings, `{{json param}}` inserts raw JSON; `transform` is a JS expression over `data`;
   `prepare` is a JS function to derive extra args; `raw: true` returns the body untouched.
2. **MCP plugins** — point at any MCP server exposed over Streamable HTTP; the harness performs `initialize`,
   `tools/list` and `tools/call` and exposes the server's tools to the model.

Plugin tools are namespaced `pluginId__toolName` and obey the same permission system.

### Reaching APIs that block browsers (CORS)
A web page can only call APIs that send CORS headers for its origin. GitHub does; Jira Server / Data Center only
after an admin allowlists your origin; **Jira Cloud never does**. Step 3 of the plugin setup offers these routes:

| Route | How it works | Needs |
|---|---|---|
| **Browser session bridge** (recommended) | a bookmarklet turns a dedicated logged-in tab into a relay; the harness pings it before each request | keep that tab open and don't browse in it; stop the browser from sleeping it ("keep awake" in the blue bar, or the browser's keep-active list) |
| Connector extension (if you may load extensions) | the tiny extension in the `extension/` folder performs the REST calls for sites you allow | `chrome://extensions` → Developer mode → *Load unpacked* → `extension` folder → add the site to allowed sites |
| Direct | browser → API | the API allows your page origin (GitHub, GitLab, allowlisted Jira DC) |
| LiteLLM pass-through / CORS proxy | browser → relay → API | someone who administers the relay |

**Extension details.** `extension/manifest.json` (Manifest V3), a service worker that does the fetch, a content script
that only activates on pages marked as the harness, and an options page with the allowed-sites list. The harness
detects it automatically and marks plugins "via extension". Requests go with cookies when the plugin uses "My browser
login session", or with the plugin's token (and without cookies) otherwise. Jira Server/Cloud work with the login
session; for GitLab use a personal access token (its cookie sessions need a CSRF token the extension cannot read).
If the harness is opened from a file, enable "Allow access to file URLs" in the extension's details.

Alternative for Jira/Confluence/GitHub: the **LiteLLM MCP gateway** plugin. The LiteLLM admin registers MCP servers
(e.g. Atlassian's remote MCP) in LiteLLM; the harness talks to `<LiteLLM>/mcp/` with your LiteLLM key, so no extra
credentials live in the browser and there is no CORS issue.

## 🔒 Security & privacy

- **No backend, no telemetry.** The only network traffic is: your LiteLLM proxy, the APIs of plugins you enabled,
  and pages the model fetches with `web_fetch` / `http_request` (requested directly by your browser).
- **No third-party services by default.** `web_fetch` is direct-only; sites that block cross-origin requests fail and
  the model is told to use `open_url` instead. `web_search` is disabled until you configure a provider (a self-hosted
  SearXNG keeps queries in-house). The optional r.jina.ai reader and CORS proxy are off and clearly labelled as
  third parties. The only other hosts contacted are CDNs that serve static code and fonts at startup (cdnjs for
  marked / DOMPurify / highlight.js, Google Fonts) and jsDelivr for Pyodide on first Python use; none of your data is
  sent to them.
- **Storage.** Settings, policies, skills and plugin manifests: `localStorage`. Chats, memories, usage: IndexedDB.
  API key and plugin credentials: a separate secret store, either `localStorage` (remembered) or `sessionStorage`
  (cleared when the tab closes) — toggle in Security & privacy. Exports never contain secrets. Plugin manifests are
  saved with credentials stripped.
- **Content Security Policy** in `index.html`: scripts only from the page itself and the two CDNs (with integrity
  hashes), the two inline bootstrap scripts allowed by hash (kept current by the release script), no plugins/objects,
  no form submission. Model markdown is rendered only when the sanitizer is present; otherwise it is shown as text.
- **Sandboxing.** JavaScript runs in a Web Worker (no DOM, no workspace); Python in Pyodide/WebAssembly inside its
  own Worker, so a timeout terminates runaway code instead of freezing the page; HTML previews render inside
  `preview.html`, a same-origin host page with its own strict CSP, in a sandboxed `srcdoc` frame with a unique origin
  ("Open in tab" opens the same host page, never a same-origin blob URL); plugin manifest expressions (`transform`, `prepare`, `pathFn`) run in the same Worker sandbox
  with no access to the page, storage or secrets, and importing a manifest that contains them shows a warning;
  CDN scripts and stylesheets carry Subresource Integrity hashes; model markdown is sanitized with DOMPurify; `<meta name="referrer" content="no-referrer">`
  keeps your page URL out of outbound requests. Workspace access requires you to pick the folder and stays inside it
  (path traversal is rejected).
- **No silent replays.** The optional CORS proxy is only used for plain GET requests without credentials or body,
  and never after a timeout; plugin calls and `http_request` are never routed through it implicitly.
- **Bridge and extension scoping.** The bookmarklet bridge only works when the harness has a real http(s) origin
  (responses are posted to that origin only; request ids are cryptographic). The connector extension only talks to
  pages served from harness origins you list in its options, and only calls APIs you list there.
- **Prompt injection.** Tool output is untrusted; the system prompt says so. Every outbound channel either asks or is
  closed: `web_fetch` and `http_request` prompt once per site (origin) in Default and Plan mode, with "allow this site
  for session / always"; a request routed through a connected browser tab (your login session) prompts in every mode,
  including Allow all; `run_*` tools and plugin writes ask in Default mode; `calculate`, `json_query` and plugin
  manifest expressions run in a Worker with fetch, XHR, WebSocket, EventSource, importScripts and nested workers
  removed; HTML previews get an injected CSP (`connect-src 'none'`, no remote images or form posts); markdown images
  are click-to-load placeholders, never fetched on render. Use Plan mode when exploring untrusted content, and review
  the arguments in every permission prompt.
- **Residual risks.** Anything stored in the browser profile is readable by other extensions or someone with access
  to your machine. Serve the app from a trusted origin; if you open it via `file://` the origin is `null`.

## 🗂 Files
```
index.html        shell
preview.html      host page for HTML previews (own CSP, sandboxed frame)
css/style.css
js/util.js        helpers, templating, HTML→text
js/db.js          IndexedDB (chats, chat index, image blobs, memory, kv)
js/settings.js    settings + secret store
js/usage.js       tokens, context estimate, cost tracking
js/bridge.js      browser-session bridge (bookmarklet relay, fallback)
js/ext.js         connector-extension client
extension/        the browser extension (Manifest V3): load unpacked in Chrome/Edge
js/permissions.js policies + permission prompt
js/llm.js         LiteLLM client (SSE streaming, tool calls)
js/fs.js          File System Access API workspace
js/runtime.js     JS worker sandbox, Pyodide, HTML preview
js/tools.js       built-in tools registry
js/plugins.js     REST plugin engine, MCP client, Jira/GitHub manifests
js/skills.js      skills
js/agent.js       agent loop
js/ui.js          UI
js/app.js         bootstrap
skills/           example skills to import
dev/              optional dev helpers: serve.js (static server), mock-litellm.js (fake OpenAI API for testing)
```

## 🚢 Releasing

```bash
node dev/release.js 1.12.0 "What changed" --push
```
This writes the version to `index.html` (`APP_VERSION`, from which every script and stylesheet gets its cache tag at
load time) and to `version.json` (what the update check reads), then commits and pushes.

## 🧪 Developing / testing without a real LLM

```bash
node dev/mock-litellm.js   # fake OpenAI-compatible API on :4000 (echoes, emits sample tool calls)
node dev/serve.js          # static server on :8765
```
Then set base URL `http://localhost:4000`, any API key, model `mock-gpt`. Messages containing "calc" trigger a
`calculate` tool call; messages containing "ask" trigger `fs_write` (exercises the permission prompt).
Libraries (marked, DOMPurify, highlight.js, fonts) load from public CDNs so the folder works out of the box with no
build step; Pyodide is fetched from jsDelivr on first Python use. Without network access to the CDNs the app still
runs (plain-text markdown, no Python).

## ⚡ Performance

Designed to stay light on modest laptops: no framework, nothing runs while idle, libraries load only when needed.
Streaming renders at most once per animation frame (syntax highlighting happens once, when the reply is complete),
long chats render their most recent part with a "Show earlier messages" control, tool cards rebuild their body only
when the result changes, the sidebar works from a small in-memory index, and storage writes are coalesced. The heavy
optional parts are Pyodide (Python, ~10 MB download and a few seconds of CPU on first use) and parsing very large
PDFs; both happen only when you use them.

## 💻 Platform notes (macOS / Windows / Linux)

- **Screens**: works from phones (sidebar becomes a drawer, dialogs go full screen, touch-friendly actions) to
  wide desktops.
- **Browsers**: Chrome and Edge give the full feature set (workspace folders via the File System Access API).
  Firefox and Safari run everything else; file tools then use an in-memory workspace.
- **Opening from a file**: double-clicking `index.html` works on every OS. Two limitations of `file://` pages:
  some browsers refuse the folder picker there, and the bridge bookmark cannot embed a file path (it links to
  the open harness tab instead, so always open the site from the wizard's Open button). Hosting the folder on any
  internal web server or static host removes both.
- **Line endings**: files with Windows `\r\n` endings are edited in place and keep their style; the model may use
  `\n` in `fs_edit` and it still matches.
- **Paths**: the model may use `\` or `/`; both work. Absolute paths (`C:\…`, `/Users/…`) are rejected with an
  explanation, since tools only operate inside the chosen workspace.
- **Shortcuts**: Ctrl (Windows/Linux) or Cmd (macOS) + K = new chat, + / = settings, + Enter = send when that mode
  is selected. Show the bookmarks bar with Ctrl/Cmd+Shift+B to drop the bridge bookmark on it.
- **Accessibility**: dialogs are announced as such and trap focus (Escape closes them, except permission prompts);
  icon buttons carry labels; a live region announces when the assistant starts, calls a tool, asks a question, and
  what it replied.
- **Tool errors are explanatory**: every failed tool call returns the cause and the fix (missing parameters, wrong
  types, unknown paths, CORS, expired permissions, HTTP status meanings), so the model can correct itself.

## 🍺 Credits & disclaimer

Made by **Milan Mozolak**.

This software is provided "as is", without warranty of any kind. The author is not responsible for anything the
assistant does with your accounts, files, tickets, repositories or systems, nor for any data loss, costs or damage
arising from its use. You are the operator: review permission prompts, use Plan mode for anything sensitive, and keep
your credentials to yourself. Use at your own risk.

Found it useful? Buy Milan a beer 🍺, in person. No links, no donations.

## 📄 License

[MIT](LICENSE). Use it, change it, ship it, commercially or not; keep the copyright notice. The bundled third-party
libraries (marked, DOMPurify, highlight.js, Pyodide) are loaded from CDNs under their own permissive licenses.
