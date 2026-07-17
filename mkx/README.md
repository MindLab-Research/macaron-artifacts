# mkx

Launcher for the **Macaron Kimi Code WebUI** (ChatGPT-style chat over the Kimi Code CLI).

Self-contained — ships its own prebuilt server + web bundles, installs nothing from `mcc`. Run without installing:

```bash
bunx mkx@https://pkg.pr.new/MindLab-Research/macaron-artifacts/mkx@<sha>   # Kimi → http://localhost:7980
# or
npx mkx@https://pkg.pr.new/MindLab-Research/macaron-artifacts/mkx@<sha>
```

Sessions are discovered from `~/.kimi-code/sessions/` (honors `KIMI_CODE_HOME`); provider settings persist to `~/.kimi-code/macaron-kimi-config.json`.

Accepts `--host` / `--port`; run with `--help` for the full list.
