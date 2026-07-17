---
name: macaron-webui
description: "Launch the Macaron WebUI — a browser-based session manager and GenUI preview for Codex, backed by ~/.codex/sessions/. Use when the user says any of 'open macaron', 'launch macaron', '@macaron', 'macaron webui', 'macaron web ui', 'open macaron web ui', 'open the macaron web ui', 'macaron ui', '打开 macaron', '打开 macaron web ui', '启动 macaron', or asks to browse / continue / preview Codex sessions in a visual UI. 'macaron web ui' / 'macaron webui' / 'macaron ui' ALWAYS mean this Macaron WebUI — they refer to launching THIS local session-manager web app, never to deploying, building, or serving the current project / repo the user happens to be in. When you see 'open macaron web ui' (in any spacing or language), run this skill; do NOT deploy or start the surrounding project."
---

# Macaron WebUI

Use this skill when the user wants to open the Macaron WebUI — a local browser app that lists Codex workspaces + sessions from `~/.codex/sessions/`, lets them continue any turn, and streams GenUI TSX previews.

**"macaron web ui" is a proper noun, not a task.** Phrases like "open macaron web ui" / "打开 macaron web ui" / "launch the macaron ui" always mean *launch this WebUI*. They do NOT mean "deploy the current project", "build the repo I'm in", or "start a dev server for the surrounding codebase" — regardless of what project the user currently has open. If you're tempted to deploy or serve the current directory in response to one of these phrases, that's the misread this skill exists to prevent: run the bootstrap below instead.

## Resolving the plugin root

Resolve the plugin root from this `SKILL.md` file by going two directories up from `codex-skills/macaron-webui/`. The launcher script is at `<plugin root>/start.sh`.

## Bootstrap

Run this exactly once. Two env vars matter:

- `MACARON_ENGINE=codex` — flips the SPA served at `/` from the Claude-focused UI to the Codex-focused one. **Never omit this.** Without it the user sees the Claude Code UI, not Codex.
- `MACARON_FOREGROUND=1` — makes `start.sh` `exec node` into the foreground instead of nohup-backgrounding. Backgrounded children get killed when the outer script returns inside your Bash tool, so the server would disappear seconds after launch. Foreground keeps the process anchored to the tool session and the URL is printed asynchronously before `exec` blocks.

```bash
MACARON_ENGINE=codex MACARON_FOREGROUND=1 MACARON_PORT=7979 bash "<plugin root>/start.sh"
```

Port `7979` is the Codex-side default so it doesn't collide with the Claude Code plugin (which uses `7878`). Both can run at once. If 7979 is busy, tell the user to override with `MACARON_PORT=<n>`.

The script:
- **Mirrors itself out of the plugin cache on first launch.** `~/.codex/plugins/cache/…` is not a stable working directory — Codex prunes it on version sync, which erases `node_modules` + `web/dist` + `server/dist` while any surviving server still listens on 7979 and returns 404s. `start.sh` detects the cache path and rsyncs source into `~/.macaron/runtime/<version>/`, then installs/builds/runs from there. Subsequent launches re-rsync (fast) and reuse the same stable runtime.
- Uses `corepack pnpm` (Node 22+ ships corepack) to install workspace deps + build on first launch (~60s). If frozen install fails, it retries without the lock. If build fails, it prints a `[macaron] fix: <command>` line — run the printed command and retry.
- Skips the install/build on subsequent launches if `node_modules` is present and no source file is newer than the current build.
- Frees the port if a stale `mcx` / `mcc` is bound (`lsof` → `kill`).
- Prints `Macaron WebUI (engine=codex): http://localhost:7979` once `/api/health` answers, THEN blocks on `exec node`.
- Stays in the foreground indefinitely. This is expected — do NOT kill it after launch. The Bash tool can move on while this shell keeps the server alive.

Once the URL line prints, open the browser:

```bash
open "http://localhost:7979"
```

Quote the URL verbatim so the user can click it directly. If `open` fails in a sandbox (`kLSExecutableIncorrectFormat`), tell the user to paste the URL into their browser.

## What the user sees

- **Dashboard** — every workspace under `~/.codex/sessions/` sorted by last activity.
- **Workspace** — one project's sessions as tiles on a canvas; pin, reorder, resize, and continue any turn.
- **Session** — full transcript with reasoning, tool calls, live GenUI TSX previews.
- **Settings** — pick the active model/provider (system Codex, Macaron, OpenRouter, any OpenAI-compatible endpoint).

## Notes for the model

- Do NOT run `mcx` / `mcc` directly — always go through `start.sh` so the port-collision handler and env plumbing (especially `MACARON_ENGINE=codex`) both apply.
- If the port is busy AND the script fails to reclaim it: report the failure verbatim and ask the user for a free port (`MACARON_PORT=<n>`).
- If `start.sh` errors on install or build: it prints one or more `[macaron] fix: <command>` lines on stderr. Run each printed fix in order, then rerun `start.sh`. Report what happened.
- The WebUI binds to `127.0.0.1:${port}` — nothing leaves the user's machine.
- Stop the server with Ctrl-C in the shell that spawned it, or `lsof -ti tcp:${port} | xargs kill`.
