# Macaron Artifacts

One React WebUI for coding harnesses. Install the `macaron-artifacts` package, start one local server, then choose Claude Code, Codex, OpenCode, pi, Hermes, or OpenClaw when creating a conversation. All six use the same chat, approvals, Canvas, and Shiki themes.

## Install and run

Requires Node.js 22.19 or newer. Claude Code, Codex, and OpenCode use their installed, authenticated native CLI and local configuration. The pi SDK is included in the package and reads your local `~/.pi/agent` configuration; a separate pi executable is not required.

Run a commit's preview package directly:

```sh
bunx macaron-artifacts@https://pkg.pr.new/MindLab-Research/macaron-artifacts/macaron-artifacts@<sha>
```

Or install that same package globally:

```sh
npm install -g https://pkg.pr.new/MindLab-Research/macaron-artifacts/macaron-artifacts@<sha>
macaron-artifacts
```

Replace `<sha>` with the commit from a successful [package preview build](https://github.com/MindLab-Research/macaron-artifacts/actions/workflows/pkg-pr-new.yml). Open `http://127.0.0.1:43860`, create a conversation, and choose its harness and workspace. An empty model field uses the harness default; for OpenCode and pi, enter an optional override as `provider/model`.

To connect the hosted WebUI, start the server with `macaron-artifacts --pair`. Open [artifacts.macaron.im/connect](https://artifacts.macaron.im/connect), enter the address and the one-time code printed in the terminal, and the browser will open the local WebUI. Pairing codes expire after ten minutes and are consumed once. For a server reached through SSH, forward its loopback port first: `ssh -N -L 43860:127.0.0.1:43860 user@host`, then use `http://127.0.0.1:43860` in the connect form.

```sh
macaron-artifacts --port 43860 --data-dir /path/to/session-data
macaron-artifacts --help
```

### Password protection and remote access

Set `MACARON_PASSWORD` or pass `--password` on the machine running the agents. To read the password without echoing or putting it in shell history:

```sh
printf 'Artifacts password: '
read -r -s MACARON_PASSWORD
printf '\n'
export MACARON_PASSWORD
macaron-artifacts
```

You can also run `macaron-artifacts --password "$MACARON_PASSWORD"`. CLI passwords can appear in shell history and process arguments.

For an SSH machine, forward the port from your computer with `ssh -N -L 43860:127.0.0.1:43860 user@host`, open `http://127.0.0.1:43860`, and enter the password. Agents, workspace files, and credentials stay on the remote machine. Password protection applies to loopback requests too; the default local server remains password-free when no password is configured.

For direct browser access through an HTTPS reverse proxy, pass `--public-origin https://artifacts.example.com` or set `MACARON_PUBLIC_ORIGIN=https://artifacts.example.com`, and preserve the browser's `Host` header when proxying to `127.0.0.1:43860`. Use `--host 0.0.0.0` (or `MACARON_HOST`) only when the server needs to listen beyond loopback. A non-loopback bind or public origin requires a non-empty password. Use HTTPS or SSH forwarding to encrypt the connection; a password alone does not encrypt HTTP.

Login uses an HttpOnly, SameSite=Strict cookie valid for 24 hours; HTTPS public origins also use Secure cookies. Restarting the server invalidates logins. The shared password grants access to the whole service, including its workspaces and Profile settings. Hosted `--pair` connections keep their separate origin-bound Bearer grants; they cannot manage password logins or other pairing grants.

There is one published package and one launcher. The old `mcc`, `mcx`, and `mkx` distributions are discontinued; harness selection belongs inside the unified application.

The previous WebUI, plugin launchers, and replay tools are archived on the [`v0` branch](https://github.com/MindLab-Research/macaron-artifacts/tree/v0).

## Features

- Native text, reasoning, tool arguments, and command output stream at the granularity each harness exposes.
- Switching conversations keeps background turns running. Refreshing reconnects to an active turn; explicit Stop cancels it.
- Harness approval requests and pi tool approvals appear in the conversation.
- Save multiple Profiles per harness, select them for new or existing conversations, and override the main model for one conversation. Profile edits apply from the next turn.
- Titles and follow-up suggestions run on disposable native forks after the main response, preserving its prompt prefix without blocking the composer.
- Inline `ui4a/tsx` fences render as their source arrives. Files at `.artifacts/canvases/<name>.ui4a.tsx` render in Canvas, including relative TSX, TypeScript, and JSON imports.
- Generated components use a small `$ui4a/ui` library and scoped chat, state, and file capabilities. Shiki themes drive both syntax highlighting and interface colors.
- Chat renders `\(...\)` and `\[...\]` LaTeX. Bundled `$ui4a/ui/katex` and `$ui4a/ui/charts` components support streaming formulas and interactive charts in `ui4a/tsx`.

Claude Code, Codex, OpenCode, pi, Hermes, and OpenClaw are supported. Hermes uses its headless JSON-RPC gateway. OpenClaw uses its pinned v4 Gateway client; its metadata enrichment requires the Macaron metadata-gate plugin and fails closed when that guard is unavailable. Native session-history migration and attachments are not included yet.

## Configuration

CLI options override their environment variables.

| Setting | Purpose |
| --- | --- |
| `MACARON_PORT` | UI and API port, default `43860` |
| `MACARON_HOST` | Listen address, default `127.0.0.1`; also accepted as `--host` |
| `MACARON_PASSWORD` | Shared service password; also accepted as `--password`; required for non-loopback listening or public origins |
| `MACARON_PUBLIC_ORIGIN` | Exact browser origin behind a reverse proxy, for example `https://artifacts.example.com`; also accepted as `--public-origin` |
| `MACARON_DATA_DIR` | App conversation storage, default `~/.macaron-artifacts/sessions` |
| `MACARON_PAIR` | Enable one-time hosted WebUI pairing (`1` or `true`) |
| `MACARON_ALLOWED_ORIGINS` | Comma-separated hosted WebUI origins, default `https://artifacts.macaron.im` when pairing is enabled |
| `MACARON_CLAUDE_PATH` | Claude Code executable |
| `MACARON_CODEX_PATH` | Codex executable |
| `MACARON_OPENCODE_PATH` | OpenCode executable |
| `PI_CODING_AGENT_DIR` | pi configuration directory, default `~/.pi/agent` |

Open **Profiles** in the sidebar to configure models, reasoning effort, service endpoints and credentials. Codex Profiles use its native `$CODEX_HOME/<name>.config.toml` files (current Codex CLI); Claude Code, OpenCode and pi use app-managed overrides. API keys and tokens are stored in a private local file under the data directory and are never returned to the browser. See [Profiles](artifacts/README.md#profiles) for supported settings and inheritance.

You can also inherit your CLI's configuration. For Claude gateways, that includes `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_API_KEY`. Variables injected only by a shell alias do not reach a separately launched app.

Workspace files remain in each conversation's selected directory. Deleting an app conversation does not delete those files. The API binds to loopback by default; password-protected remote access uses the same WebUI, while `--pair` adds an origin-bound Bearer connection for the hosted WebUI. Generated React runs in the host page; use it with trusted code.

## Development

From the repository root:

```sh
pnpm install
pnpm dev
pnpm typecheck
pnpm test
pnpm build
pnpm start
```

Development serves the UI on `http://127.0.0.1:43861` and API on `http://127.0.0.1:43860`; `WEB_PORT` and `MACARON_PORT` override them. Production serves both from one port.

See [the application guide](artifacts/README.md) for module boundaries, streaming contracts, and validation.
