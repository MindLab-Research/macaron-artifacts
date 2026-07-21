# Session replay recording

Replay recording runs the production Macaron web application. There is no
second replay component tree, HTML template, or stylesheet.

`scripts/replay/server.mjs` exposes the same workspace, session, and live SSE
endpoints used by a real run. The existing `Workspace`, `Session`, `ItemView`,
and `StaticGenUIRenderer` components consume those events unchanged. The
recorder captures that real route frame by frame and encodes it with FFmpeg.

```bash
pnpm replay:test
pnpm replay:render
```

The default fixture is `replays/checkout-latency.json`. Pass another fixture or
output path directly to the recorder after building the web app:

```bash
pnpm build:web
node scripts/replay/render.mjs --input replays/my-session.json --output out/my-session.mp4
```

Chrome or Chromium and FFmpeg must be installed. Set `CHROME_PATH` when the
browser executable is not in a standard system location.
