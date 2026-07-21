#!/usr/bin/env bash
# Macaron Artifacts — one-liner installer + launcher for users coming from a
# relay's docs page. Skips Claude Code entirely (the `/macaron` slash command
# path still works too — this is the "no REPL, just a browser" flavor).
#
# Ships to https://macaron.im/install.sh (redirect / mirror of this file).
#
# Usage — with a Macaron-hosted API relay:
#
#   export ANTHROPIC_BASE_URL='https://mint.macaron.im/v1'
#   export ANTHROPIC_AUTH_TOKEN='sk-xxx'
#   bash <(curl -fsSL https://macaron.im/install.sh)
#
# Or use the macaron-scoped env vars if you don't want to alter the ANTHROPIC_*
# ones for the rest of your shell:
#
#   export MACARON_PROVIDER_ENDPOINT='https://mint.macaron.im/v1'
#   export MACARON_PROVIDER_TOKEN='sk-xxx'
#   export MACARON_PROVIDER_MODEL='macaron-v1-venti'
#   export MACARON_PROVIDER_NAME='Mint'
#   bash <(curl -fsSL https://macaron.im/install.sh)
#
# What this does:
#   1. Checks the local `git` + `node` toolchain.
#   2. Clones / updates the plugin source to ~/.macaron/artifacts-src (override
#      with MACARON_ARTIFACTS_HOME=/some/path).
#   3. Hands off to the plugin's start.sh, which runs `pnpm install && build`
#      on first launch (~60s) and then serves the WebUI on http://localhost:7878.
#   4. The server's boot-time seedProviderFromEnv() picks up the env vars above,
#      upserts them as a saved provider, and (if you were still on the built-in
#      System provider) activates it. Open the URL and start — no manual
#      Settings → Add provider needed.

set -euo pipefail

PLUGIN_HOME="${MACARON_ARTIFACTS_HOME:-$HOME/.macaron/artifacts-src}"
REPO_URL="${MACARON_ARTIFACTS_REPO:-https://github.com/MindLab-Research/macaron-artifacts.git}"
BRANCH="${MACARON_ARTIFACTS_BRANCH:-main}"
PORT="${MACARON_PORT:-7878}"

log() { printf '[macaron] %s\n' "$*"; }
die() { printf '[macaron] error: %s\n' "$*" >&2; exit 1; }

command -v git  >/dev/null 2>&1 || die "git not found. Install: https://git-scm.com/"
command -v node >/dev/null 2>&1 || die "node not found. Install Node 22+: https://nodejs.org/"

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
[ "$NODE_MAJOR" -ge 22 ] || die "Node $NODE_MAJOR is too old. Macaron needs Node 22+."

# Clone or update the plugin source. Depth 1 keeps the download small; a full
# reset --hard on refresh means local edits under PLUGIN_HOME are discarded —
# which is fine because this dir is our own managed install target.
if [ ! -d "$PLUGIN_HOME/.git" ]; then
  log "installing to $PLUGIN_HOME (fresh clone)…"
  mkdir -p "$(dirname "$PLUGIN_HOME")"
  git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$PLUGIN_HOME"
else
  log "updating $PLUGIN_HOME…"
  git -C "$PLUGIN_HOME" fetch --depth 1 origin "$BRANCH"
  git -C "$PLUGIN_HOME" reset --hard "origin/$BRANCH"
fi

[ -x "$PLUGIN_HOME/start.sh" ] || die "start.sh missing from $PLUGIN_HOME — repo layout drifted?"

# Try to open the browser once the port is up. Backgrounded so start.sh can
# take over the foreground (its `exec node` blocks intentionally). If start.sh
# fails before the port binds, this loop just times out silently — the user
# sees start.sh's stderr and knows what to do.
open_when_ready() {
  local url="http://localhost:$PORT"
  local i=0
  while [ "$i" -lt 60 ]; do
    if curl -sf "$url/api/workspaces" >/dev/null 2>&1; then
      log "opening $url"
      if   command -v open >/dev/null 2>&1;     then open "$url"
      elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$url" >/dev/null 2>&1 || true
      else                                          log "browser open failed — visit $url manually"
      fi
      return
    fi
    sleep 0.5
    i=$((i + 1))
  done
  log "server didn't come up on port $PORT within 30s — check the log above"
}
open_when_ready &

# Hand off. start.sh handles pnpm install / build / port conflicts / restart.
# env vars we care about (ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN, MACARON_PROVIDER_*)
# propagate through exec into the Node server, where seedProviderFromEnv reads
# them at startup.
exec bash "$PLUGIN_HOME/start.sh"
