# Macaron Artifacts

Macaron Artifacts publishes the plugin manifests, local WebUI runtime, GenUI tooling, and docs for running Macaron with Claude Code, Codex, and Kimi Code.

1. **Visual sessions** — browse workspaces and sessions with previews, then continue a turn from the browser.
2. **Live chat** — stream thinking, tool calls, and GenUI previews from supported agent runtimes.
3. **Provider controls** — run against an ambient login or a compatible endpoint such as Macaron, OpenRouter, or LiteLLM.

The plugin bundle includes the official **`genui-builder` skill** so supported agents can produce GenUI TSX from the command line.

---

## Platform Support

Macaron Artifacts currently targets Linux and macOS. Native Windows environments may have compatibility issues; use Linux, macOS, or WSL for the most reliable experience.

## Install

The repo doubles as its own plugin marketplace. Use the full https URL — the `owner/repo` shorthand may clone over SSH, which fails without a GitHub SSH key.

### Claude Code

In a Claude Code session, run each command separately (pasting both lines at once merges them into one command):

```
/plugin marketplace add https://github.com/MindLab-Research/macaron-artifacts
```

```
/plugin install macaron@macaron
```

or from the shell:

```bash
claude plugin marketplace add https://github.com/MindLab-Research/macaron-artifacts
claude plugin install macaron@macaron
```

For local development, install your checkout directly: `claude plugin install /path/to/macaron`.

### Codex

```bash
codex plugin marketplace add https://github.com/MindLab-Research/macaron-artifacts
codex plugin add macaron@macaron
```

### Kimi Code

In a Kimi Code session, install from the GitHub URL, then reload to activate:

```
/plugins install https://github.com/MindLab-Research/macaron-artifacts
/reload
```

### Run without installing

Three independent packages, each self-contained (its own prebuilt server + web bundles) — `mcc` (Claude WebUI, port `7878`), `mcx` (Codex WebUI, port `7979`), and `mkx` (Kimi WebUI, port `7980`). Install one, get only that one. Launch any of them in one command, no plugin install needed:

```bash
bunx mcc@https://pkg.pr.new/MindLab-Research/macaron-artifacts/mcc@<sha>   # Claude → http://localhost:7878
bunx mcx@https://pkg.pr.new/MindLab-Research/macaron-artifacts/mcx@<sha>   # Codex  → http://localhost:7979
bunx mkx@https://pkg.pr.new/MindLab-Research/macaron-artifacts/mkx@<sha>   # Kimi   → http://localhost:7980
```

`npx` works the same way — bin name = package name for all three:

```bash
npx mcc@https://pkg.pr.new/MindLab-Research/macaron-artifacts/mcc@<sha>   # Claude → http://localhost:7878
npx mcx@https://pkg.pr.new/MindLab-Research/macaron-artifacts/mcx@<sha>   # Codex  → http://localhost:7979
npx mkx@https://pkg.pr.new/MindLab-Research/macaron-artifacts/mkx@<sha>   # Kimi   → http://localhost:7980
```

Replace `<sha>` with a commit on `main` (see the [pkg.pr.new builds](https://github.com/MindLab-Research/macaron-artifacts/commits/main)). All three accept `--host` / `--port`; run with `--help` for the full list.

Verify:

```bash
claude plugin list
# → macaron@macaron  (commands: /macaron, skills: genui-builder)
```

## Use

Inside Claude Code:

```
/macaron
```

The slash command starts the local server (`node server/dist/index.js`, port `7878` by default) and opens `http://localhost:7878` in your browser. Pass a custom port with `/macaron 8080`.

Inside Codex, ask it to open the Macaron WebUI. The Codex-side default port is `7979`.

Inside Kimi Code, run `/macaron:macaron`. The Kimi-side default port is `7980`.

### Views

| View          | What it does |
| ------------- | ------------ |
| **Dashboard** | All workspaces from `~/.claude/projects/**/*.jsonl`, sorted by last activity. |
| **Workspace** | Sessions of one project with previews; start a new session from here. |
| **Session**   | Full transcript (thinking, tool calls, live GenUI TSX previews) + follow-up messages streamed over SSE. |
| **Settings**  | Manage Anthropic-compatible providers and pick the active one (stored in `~/.claude/macaron-config.json`). |

## Configure

Zero config by default — sessions run against your ambient Claude Code login. Add an Anthropic-compatible provider from the **Settings** page (persisted to `~/.claude/macaron-config.json`), or override via env — copy `.env.example` to `.env` (git-ignored) before launching:

```bash
MACARON_API_BASE=https://api.example.com/v1
MACARON_API_KEY=<api-key>
MACARON_MODEL=<model-id>       # optional
MACARON_PORT=7878             # optional
```

### Exposing on your LAN

By default the server binds to `127.0.0.1`, so only the local machine can reach it — no auth needed. To use the WebUI from your phone or another machine, bind to a routable address and set a shared token:

```bash
MACARON_HOST=0.0.0.0 MACARON_AUTH_TOKEN=your-long-random-token /macaron
```

Remote requests must then present the token; localhost stays frictionless (loopback is never challenged). The web app shows a one-field unlock screen, and you can share a ready-to-use link as `http://<host>:7878/?token=your-long-random-token` (the token is stored and stripped from the URL on first load). If you bind to a non-loopback host **without** setting a token, the server generates one at boot and prints it to the log so it's never left wide open.

## Layout

```
.claude-plugin/                   plugin manifest + marketplace (install from GitHub)
.kimi-plugin/                     Kimi Code plugin manifest
commands/macaron.md               /macaron slash command
commands-kimi/                    Kimi Code slash commands (/macaron:macaron)
skills/genui-builder/             bundled GenUI authoring skill
skills/macaron-webui-kimi/        Kimi Code WebUI skill
mkx/                              self-contained Kimi launcher package (port 7980)
start.sh                          one-time npm install + build, boots server in background
shared/                           domain types + SSE protocol (server ↔ web)
server/                           Fastify API, Claude Agent SDK runner, provider relay
web/                              Vite + React UI
site/                             Fumadocs docs + landing site (standalone, not in the workspace)
```

## Notes

- Built and tested against **Node 22**.
- Claude Code stores project directories as `~/.claude/projects/-<encoded-path>`; hyphens in the original folder name are ambiguous (we display the best-guess decoded path).
- Kimi Code stores sessions under `~/.kimi-code/sessions/<workDirKey>/<sessionId>/` (one bucket per working directory), with `~/.kimi-code/session_index.jsonl` as a fast sessionId → directory index.
