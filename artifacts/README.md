# Macaron Artifacts

A single React WebUI for native coding harnesses. Claude Code, Codex, OpenCode, pi, Hermes, and OpenClaw share the same conversation, approvals, UI4A rendering, session storage, and themes. The default layout and palette come from `ui4a-playground`.

## Install and run

The only published package and CLI is `macaron-artifacts`. Choose Claude Code, Codex, OpenCode, pi, Hermes, or OpenClaw inside the application; installing another WebUI package is not required to switch harnesses. Node.js 22.19 or newer is required.

```sh
bunx macaron-artifacts@https://pkg.pr.new/MindLab-Research/macaron-artifacts/macaron-artifacts@<sha>
```

Use the SHA from a successful package preview build, then open `http://127.0.0.1:43860`. For a persistent installation, install that same package URL with `npm install -g` and run `macaron-artifacts`. The launcher accepts `--port`, `--data-dir`, `--host`, `--password`, `--public-origin`, and `--pair`; CLI options override their environment variables.

## Password protection and remote access

Set `MACARON_PASSWORD` or pass `--password` to require a shared password before accessing sessions, Profiles, streams, or workspace files. The login screen uses an HttpOnly, SameSite=Strict cookie that expires after 24 hours; restarting the server or logging out invalidates that login. The password grants access to the whole service, not an individual workspace or user account. An unset password preserves the default local behavior. CLI passwords can appear in shell history and process arguments.

For an SSH machine, start the server there with a configured password, then use `ssh -N -L 43860:127.0.0.1:43860 user@host` on your computer and open `http://127.0.0.1:43860`. Loopback access still requires the configured password. See the [root guide](../README.md#password-protection-and-remote-access) for hidden-input environment and CLI examples.

`--host` or `MACARON_HOST` changes the default `127.0.0.1` bind. Non-loopback listening requires a non-empty password. For an HTTPS reverse proxy, use `--public-origin` or `MACARON_PUBLIC_ORIGIN` for the exact browser origin and preserve its `Host` header; a non-loopback public origin requires a password even when the backend binds to loopback. The server does not infer trust from `X-Forwarded-*` headers. HTTPS public origins use Secure cookies. Use HTTPS or SSH forwarding to keep the password and session traffic encrypted.

`--pair` remains available for the hosted WebUI. Its origin-bound Bearer grants authorize the paired connection independently of the password, but do not authorize password endpoints or management of pairing grants. Password login and pairing administration remain same-origin operations.

## Development

```sh
pnpm install
pnpm dev
# UI: http://127.0.0.1:43861 — API: http://127.0.0.1:43860
pnpm build
pnpm start
```

Run these commands from the repository root. `MACARON_PORT` and `WEB_PORT` override the ports. Production serves the UI and API together.

The picker checks the runtime each adapter actually uses, not whether every harness has a command on PATH:

- **Claude Code** uses the bundled SDK and its optional platform binary by default. Keep optional dependencies enabled. `MACARON_CLAUDE_PATH` selects an authoritative CLI or script override; a broken override does not fall back to the bundled binary.
- **pi** uses the bundled SDK; no separate `pi` CLI is required. It uses local `~/.pi/agent` configuration, or `PI_CODING_AGENT_DIR`.
- **Codex / OpenCode** require external CLIs. `MACARON_CODEX_PATH` and `MACARON_OPENCODE_PATH` override the executables.
- **Hermes** uses an external CLI (`MACARON_HERMES_PATH` or `hermes`) unless a Profile's Gateway URL or `MACARON_HERMES_URL` selects an external gateway. A saved gateway Profile can be used without a local CLI.
- **OpenClaw** uses the bundled Gateway Client and an external gateway, not a local `openclaw` command. Configure the Profile or `OPENCLAW_GATEWAY_URL` (default `ws://127.0.0.1:18789`).

Runtime availability does **not** check model credentials or gateway connectivity. No model requests or gateway handshakes are made by the availability checks. Session creation rechecks the selected runtime/Profile before saving. An empty model field uses the harness default; OpenCode and pi accept an optional `provider/model` override.

App conversations live in `~/.macaron-artifacts/sessions`; `MACARON_DATA_DIR` overrides that directory. Workspace files remain in the directory selected for each session. Deleting an app conversation does not delete workspace files.

For a custom Claude gateway, start the app with the same `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_API_KEY` environment as the CLI. Environment injected only by a shell alias is not inherited by a separately launched app.

## HTML snapshots

Use the export arrow beside **Source** on an inline card or in the Canvas header to download or copy an HTML snapshot after the preview finishes. Canvas downloads use the artifact name. Snapshots preserve the rendered content, current form values, readable canvas images, and active theme. They are static: React handlers, chat/file capabilities, scripts, and embedded frames are not included. External images, fonts, and styles may still require network access. Switch back to preview before exporting from source view.

The conversation title bar also exports the whole chat after the current turn finishes. Its HTML contains only the message column in the current theme, including links, highlighted code, tool calls, and complete reasoning history. Tool details, long outputs, and earlier summaries can still expand and collapse without the app server. The sidebar, composer, suggestions, and approval actions are omitted; inline cards remain static snapshots. A small embedded script handles transcript controls only.

## Boundaries

| Module | Responsibility |
| --- | --- |
| `src/server/harnesses` | Native lifecycle, protocol conversion, permission callbacks, capability declarations |
| `src/server/conversations.ts`, `store.ts` | One turn per session, persistence, complete increment journal, disconnect/reconnect and explicit cancellation |
| `src/server/enrichment.ts` | Background title and suggestions on a disposable native fork |
| `src/server/profiles.ts`, `src/shared/profiles.ts` | Private profile persistence, redacted public settings, revisions and per-turn resolution |
| `src/server/artifacts.ts` | Full-file speculative previews from tool input; authoritative reads after writes and patches |
| `src/shared/types.ts` | AI SDK UI messages and host data parts; no harness-owned UI types |
| `src/web/chat` | Stable per-session AI SDK Chat instances, queueing, metadata subscription |
| `src/web/components` | Shared conversation, composer, sidebar, approvals and Canvas views |
| `src/web/ui4a` | Incremental TSX renderer, scoped module registry, relative imports and state |
| `src/web/theme` | Shiki palette → semantic CSS variables shared by the UI and generated components |

New harnesses implement `HarnessAdapter` and register their capabilities. They do not add another SPA, sidebar, message store or Canvas. Native event boundaries pass through unchanged. Rendering can coalesce work already waiting on a compile; there is no fixed transport debounce.

## Profiles

Open **Profiles** in the sidebar to create or edit a configuration. Select it in **New conversation** or **Conversation settings**; an optional conversation model overrides only its main model. Empty fields inherit native settings. Existing sessions without Profiles continue to work.

| Harness | Profile settings |
| --- | --- |
| Claude Code | Main/subagent models, optional forced subagent model, effort, Base URL, API key or Bearer token; model aliases and fine-grained tool streaming |
| Codex | Native Profile files, main/subagent models and effort, provider/Base URL, API key; searchable native features with inherit/on/off states and managed restrictions |
| OpenCode v1 | Main model, provider/Base URL, API key, model variant, main agent and per-subagent model overrides |
| OpenCode v2 | Independent Profiles with main model, provider/Base URL, API key, model variant, main agent and per-subagent model overrides |
| pi | Model, provider/Base URL, API key and the model's supported thinking levels; pi has no built-in subagents |
| Hermes | Native model/reasoning overrides, optional Gateway URL/Profile, Gateway token; provider credentials remain in Hermes |
| OpenClaw | Native model/thinking overrides, optional Gateway URL/Profile/agent, Gateway token; provider credentials remain in OpenClaw |

Edits affect the next turn of every conversation using that Profile. The current turn and its title/suggestion fork retain one captured configuration. Switching a conversation's Profile is available when its current turn finishes and keeps native history. A Profile in use cannot be deleted until its conversations select another configuration.

Codex uses the current native `<name>.config.toml` format under `CODEX_HOME` (default `~/.codex`), shared with the CLI. Editing preserves unknown fields and comments; stale edits are rejected. The app-server does not accept `--profile`, so the adapter resolves the file and trusted project layers into per-thread overrides. It preserves Codex's configuration precedence and login/session directory. Legacy `[profiles.name]` tables are not used.

Other harnesses receive per-process or per-session overrides without rewriting their native configuration. Credentials for all harnesses live only in `profiles/profiles.json` under `MACARON_DATA_DIR`, with owner-only directory/file permissions (`0700`/`0600`); this is a local plaintext secret store, not an OS keychain. The API returns only whether a private credential is configured. Leaving a saved credential blank keeps it; **Remove credential** clears it when saved. Inherit authentication uses the harness's existing local login or environment.

Model and feature choices come from the native SDK/CLI. Custom model IDs remain editable when discovery is unavailable. pi custom models still need an appropriate native `models.json` definition; the app does not invent provider capabilities. No credentials are stored in browser preferences, conversation files or stream journals.

## Why native adapters with AI SDK UI

AI SDK 7's experimental [HarnessAgent](https://ai-sdk.dev/docs/ai-sdk-harnesses/overview) and harness packages were assessed; the official `harness-pi` package supports a host process, so sandboxing is not a universal constraint. Direct native integration keeps control over session persistence, metadata branches, local configuration, and approval callbacks. We use the Claude SDK, [Codex app-server](https://developers.openai.com/codex/app-server), OpenCode SDK connected to its local CLI server, and pi SDK, normalizing their events into the existing AI SDK UI message stream. The client keeps its shared `@ai-sdk/react` Chat and `useChat` APIs.

| Native capability | Claude Code | Codex | OpenCode v1 | OpenCode v2 | pi | Hermes | OpenClaw |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Text/reasoning deltas | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| Tool input | Raw deltas | Completed input | Snapshots | Raw deltas | Raw deltas | Native tool events | Gateway events |
| Approval | Native callback | Native request | Native permission | Native permission/forms | SDK hook | Gateway approval | Gateway approval |
| Metadata isolation | Native fork | Ephemeral fork | Deleted fork | Deleted fork | In-memory branch | `prompt.btw` | Guarded native fork |

Metadata retains the same instructions, model and tool catalog, appending only its final metadata request. OpenCode's fork blocks execution through a tool hook; pi uses an in-memory native branch that retains session affinity and blocks tools at execution. It runs outside the main turn and is cancelled when a new turn arrives. This is prefix-friendly; cache hits still depend on the upstream provider. Usage parts preserve the native cached-input count. Metadata failure leaves the main response intact.

Native questions from Claude Code (`AskUserQuestion`), Codex (`requestUserInput`), OpenCode, and pi extension `select`/`input` dialogs appear as inline forms with choices, custom answers, and multi-question navigation. Answers return to the waiting native turn; cancelling declines the questionnaire. Pending forms and non-secret drafts survive browser refresh and conversation switching. Stopping a turn or restarting the server closes its pending forms. Tool execution approvals remain separate. Arbitrary pi terminal widgets and editors are not supported.

### OpenCode generations

**OpenCode v1** keeps persisted ID `opencode`; **OpenCode v2** uses `opencode-v2`. They are separate adjacent choices in the session picker and Profiles, with no automatic migration of existing sessions or settings. `MACARON_OPENCODE_PATH` selects v1 (`opencode` by default). `MACARON_OPENCODE_V2_PATH` selects v2 (`opencode2`, then major-checked `opencode`). Explicit wrong-major binaries are rejected before server startup.

V1 uses `@opencode-ai/sdk@1.18.29` and its `/v2/client` export; that namespace is not the native v2 CLI. Native v2 uses `@opencode/client@2.0.13`, `OpenCode.make`, `/api/session` and execution events. Both inherit native configuration without rewriting it. Because both native majors otherwise open incompatible `opencode.db` schemas, the v2 child uses a separate persistent `macaron-artifacts-v2.db` in the native data directory (overriding `OPENCODE_DB` only for that child). The v1 database and its existing sessions are left untouched; native auth/config paths are unchanged. Metadata v2 uses an actual directory plugin (`index.mjs`), blocks tool execution without filtering tool definitions, and preserves the completed parent's system/tool prefix and cache affinity. Private prefix snapshots survive process restarts under `$XDG_DATA_HOME/macaron-artifacts/opencode-v2-prefixes` (default `~/.local/share/...`); missing/mismatched prefixes fail closed. Disposable forks are deleted; the parent's history remains unchanged.

V2 question forms support ordinary text, choices, multiselect, number and boolean fields. External/conditional forms require the native UI and fail explicitly rather than silently supplying an answer. Native retry uses `resume: true`; pending approvals/questions are interrupted on Stop. Provider cache hits are not guaranteed.

Opt-in native checks use isolated native binaries and a scripted loopback model provider, not cloud-provider E2E:

```sh
MACARON_OPENCODE_SMOKE_PATH=/path/to/v1/opencode bun test artifacts/src/server/harnesses/opencode-live.test.ts artifacts/src/server/harnesses/opencode-profiles-live.test.ts
MACARON_OPENCODE_V2_SMOKE_PATH=/path/to/v2/opencode bun test artifacts/src/server/harnesses/opencode-v2-live.test.ts artifacts/src/server/harnesses/opencode-v2-profiles-live.test.ts
```

## UI4A contract

- Inline: a fenced `ui4a/tsx` module renders in the conversation while its text arrives.
- Canvas: `.artifacts/canvases/<name>.ui4a.tsx` opens in the right panel. Relative TypeScript, TSX and JSON modules resolve inside `.artifacts`.
- Both use `partial-react`, `pushCode`/`finish`, last-good-frame preservation and a shared React instance.
- This application's small `$ui4a/ui` library contains Button, Field, Card, Badge, Tabs and Disclosure. Compose layouts with native HTML and UnoCSS Wind4 utilities; use `@headlessui/react` for additional controls. `$ui4a/ui/charts` provides responsive Recharts components with streaming snapshots, stable data/axes and restrained animation; `$ui4a/ui/katex` provides `LaTeX` and `MathBlock`. Both are bundled locally. Combine formulas, line charts and numeric sliders in `ui4a/tsx` to explore parameter changes. `$ui4a/chat`, `$ui4a/state` and `$ui4a/fs` are separate host capabilities.
- Chat and reasoning render `\(...\)` inline math, `\[...\]` display math, and `$$` math with KaTeX. Code and link destinations stay literal, and single dollar signs remain ordinary currency text. Long display formulas scroll within their container.
- The module manifest generates `skills/ui4a/SKILL.md`; a test checks that the guidance matches the runtime. No theme name is added to the model prompt.
- All bundled Shiki themes are searchable in the sidebar. Hover or use arrow keys to preview; click or press Enter to save. Closing the picker restores the saved palette. UI colors normalize missing and transparent editor tokens and validate text, button, hover, and focus contrast.
- Controls use [VS Code's component color roles](https://code.visualstudio.com/api/references/theme-color#input-control): input backgrounds, labels, placeholders and borders come from `input.*`; selects use `dropdown.*`. Absent borders remain transparent unless the theme supplies a contrast border; `focusBorder` provides the independent focus indicator.
- Workbench regions keep their own foreground/background pairs: `sideBar.*`, `titleBar.*`, `editorWidget.*`, `menu.*` and list selection colors. Alpha colors composite against the owning region, including controls inside dialogs. Optional borders and `widget.shadow` retain explicit transparency; `panel.border` is reserved for pane boundaries. A supplied `contrastBorder` remains an accessibility fallback when a component border is absent.
- Tool and reasoning rows use spacing and expanded content instead of repeated frames. The small UI4A Card and Disclosure components follow the same restrained defaults. Shiki syntax stays on `editor.background`; `textCodeBlock.background` belongs to the surrounding Markdown container. Insufficient syntax foreground contrast receives a minimal tonal correction in the highlighter's copy of the theme; original workbench colors stay intact.

Generated code runs as trusted React code in the host page, as in the reference playground; this is not an isolation sandbox for untrusted third-party code. File bridge access is restricted to the selected workspace's `.artifacts` tree, including symlink checks. The API accepts same-origin browser requests and requires a login whenever a password is configured.

## Validation

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm test:package
MACARON_PACKAGE_SOURCE=https://pkg.pr.new/MindLab-Research/macaron-artifacts/macaron-artifacts@<sha> pnpm test:package
```

Tests exercise harness event conversion, real JSONL RPC framing, approval/cancellation, >4,000-event replay, crash recovery, metadata isolation, scoped capabilities and incremental rendering. Browser acceptance uses the real built application for inline and file previews, state retention, relative imports, theme switching and narrow layouts.

`test:package` builds and installs the package into an empty consumer directory, then starts its CLI and checks the harness catalog, all client assets, and password-protected login/logout and restart behavior. It also checks that non-loopback configurations refuse to start without a password. `MACARON_PACKAGE_SOURCE` runs the same acceptance checks against a published preview URL or an existing tarball.

The root package publishes only the unified application. The old `mcc`, `mcx`, and `mkx` distributions are discontinued. Native session-history migration, attachments, and the old administrative panels are outside this adapter slice.

## Deferred adapters

OpenClaw metadata enrichment requires the bundled metadata-gate plugin to be installed and enabled in the Gateway; the adapter refuses to run an unguarded fork. Kimi Code and dsh remain deferred.
