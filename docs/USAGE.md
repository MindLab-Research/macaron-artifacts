# Macaron Artifacts

A local WebUI that ships as a plugin for Claude Code, Codex, and Kimi Code — install any of them, and they run side-by-side:

- Claude → <http://localhost:7878>
- Codex → <http://localhost:7979>
- Kimi → <http://localhost:7980>

## Install

### Claude Code

```
/plugin marketplace add https://github.com/MindLab-Research/macaron-artifacts
/plugin install macaron@macaron
```

Open it in a session with `/macaron`.

### Codex

```bash
codex plugin marketplace add https://github.com/MindLab-Research/macaron-artifacts
codex plugin add macaron@macaron
```

Open it in a session with `open macaron web ui`.

### Kimi Code

```
/plugins install https://github.com/MindLab-Research/macaron-artifacts
/reload
```

Open it in a session with `/macaron:macaron`.

### No plugin — one-liner via bunx / npx

Three independent packages, each shipping its own prebuilt server + web assets:
`mcc` (Claude WebUI on port `7878`), `mcx` (Codex WebUI on port `7979`), and `mkx` (Kimi WebUI on port `7980`).
Install none of them; run whichever you want directly:

```bash
bunx mcc@https://pkg.pr.new/MindLab-Research/macaron-artifacts/mcc@<sha>   # Claude → http://localhost:7878
bunx mcx@https://pkg.pr.new/MindLab-Research/macaron-artifacts/mcx@<sha>   # Codex  → http://localhost:7979
bunx mkx@https://pkg.pr.new/MindLab-Research/macaron-artifacts/mkx@<sha>   # Kimi   → http://localhost:7980
```

`npx` works the same — all three packages have `bin` name == package name:

```bash
npx mcc@https://pkg.pr.new/MindLab-Research/macaron-artifacts/mcc@<sha>    # Claude → http://localhost:7878
npx mcx@https://pkg.pr.new/MindLab-Research/macaron-artifacts/mcx@<sha>    # Codex  → http://localhost:7979
npx mkx@https://pkg.pr.new/MindLab-Research/macaron-artifacts/mkx@<sha>    # Kimi   → http://localhost:7980
```

Replace `<sha>` with any commit on `main`. Each launcher just boots the same server with `MACARON_ENGINE` set (`codex` / `kimi`; unset = Claude) and its own default port. All bins accept `--host` / `--port`; run with `--help` for the full flag list.

## Using the WebUI

Once open:

- Click a workspace in the sidebar to enter its canvas; pin a session with the `+` button.
- On the canvas: drag the grip to reorder tiles, drag the SE corner to resize, click a tile to focus.
- Composer: **Enter** sends · **Shift+Enter** newline · **↑ / ↓** cycles prompt history · paste an image to attach it directly.

First time on the Codex side, open **Settings** and fill in your Base URL / API key / Model. Same on the Kimi side if you want a custom provider — by default it uses your ambient Kimi Code login.

## Update

### Claude Code

```
/plugin update macaron
```

### Codex

```bash
codex plugin marketplace upgrade macaron   # pull the latest version
codex plugin remove macaron@macaron
codex plugin add macaron@macaron           # reinstall
```

### Kimi Code

Open `/plugins`, select `macaron` on the **Installed** tab, and press `Enter` to install the available update — then `/reload`.

## Feedback

Open an issue: <https://github.com/MindLab-Research/macaron-artifacts/issues>
