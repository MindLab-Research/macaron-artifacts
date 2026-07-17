---
description: Launch the Macaron WebUI (GenUI builder, model switcher, session manager)
---

This command is invoked as `/macaron:macaron`. It starts the Macaron WebUI server backed by your Kimi Code sessions in `~/.kimi-code/sessions/`.

The optional port is supplied to you as `$ARGUMENTS` (whatever the user typed after the command). If it is empty, use 7980 — the Kimi-side default, so it doesn't collide with the Claude Code (7878) or Codex (7979) flavors of this launcher.

First, resolve the plugin root: this command file lives at `<plugin root>/commands-kimi/macaron.md`, so the plugin root is two directories up from this file. The launcher script is at `<plugin root>/start.sh`.

The plugin arrives as source (no committed `dist/`) — `start.sh` uses `corepack pnpm` to install and build on first launch (~60s), then reuses the cached build on subsequent launches. When invoked from a plugin cache directory (which the host can prune under us), it transparently mirrors source into `~/.macaron/runtime/<version>/` and runs from there so `node_modules` / `dist` survive. Port collisions, install / build retries, and URL printing are all handled inside the script. **Do NOT** rm node_modules, run npm install, run npm run build, or otherwise "prepare" the plugin before invoking `start.sh` — call it once and let it print. If it errors out, follow the `[macaron] fix: <command>` lines it prints on stderr and try again.

Run exactly this and nothing else (with the resolved plugin root substituted). `MACARON_ENGINE=kimi` selects the Kimi Code UI, and `MACARON_FOREGROUND=1` anchors the server to this shell — backgrounded children get killed when the outer script returns, so the server would disappear seconds after launch:

```bash
MACARON_ENGINE=kimi MACARON_FOREGROUND=1 MACARON_PORT="${1:-7980}" bash "<plugin root>/start.sh"
```

The server stays in the foreground indefinitely. This is expected — do NOT kill it after launch.

After the server prints `Macaron WebUI (engine=kimi): http://localhost:<port>`, run `open "http://localhost:<port>"` to launch the browser, then quote the URL verbatim to the user (don't paraphrase it) and briefly summarize what's there:

- **Dashboard** — all workspaces from `~/.kimi-code/sessions/`, sorted by last activity
- **Workspace** — one project's sessions with previews; start a new session from here
- **Session** — full transcript (tool calls, live GenUI previews) + follow-up chat
- **Settings** — manage model providers (Kimi, Anthropic-compatible, OpenAI-compatible, …) and pick the active one

If `start.sh` prints an error:

- **Port busy**: report the error verbatim and ask the user for a free port to retry.
- **Install / build failed**: `start.sh` prints one or more `[macaron] fix: <command>` lines on stderr. Run each printed fix command in order and retry `start.sh` after each; report the outcome to the user.
- **Anything else**: quote the raw stderr, then check `/tmp/macaron-plugin.log` for the server-side tail before proposing next steps.
