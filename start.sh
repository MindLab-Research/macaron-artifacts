#!/usr/bin/env bash
set -euo pipefail

# Macaron plugin entry point. Builds and launches the WebUI server.
#
# We do NOT ship prebuilt dist/ in the repo — every commit rebuilding
# server/dist + web/dist caused unresolvable rebase conflicts across
# concurrent PRs. Instead the plugin arrives as source, and this script
# does one build on first launch (~60s) then runs `node …` on every
# subsequent launch.
#
# Design invariants for the AI agent that spawns this via `/macaron`:
#  * Any failure inside install/build prints an actionable "Try …" line
#    to stderr. The agent can read stderr, run the printed command, and
#    retry — no human intervention needed.
#  * The script is idempotent: running it twice from a clean cache
#    installs once; running after `git pull` rebuilds only if source
#    changed (mtime check).
#  * Uses pnpm via corepack (Node 22+ ships with it), so plain `node` +
#    `bash` on the user's machine is enough — no manual npm/pnpm setup.

SRC_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

# --- Preflight: dependency check ----------------------------------------
# Every subsequent step (mirror rsync, corepack pnpm, install, build, node
# launch) assumes Node 22+ exists. Without this block a fresh install on a
# machine with no Node blows up ~40 lines later inside `corepack` with a
# cryptic "command not found", which we've watched real users hit.
#
# Strategy: detect early, print platform-specific install guidance, and offer
# a one-keypress nvm bootstrap for the two paths (Node missing / Node too old)
# that we can safely fix without sudo. Skip auto-install on Windows Git-Bash
# — Node installers there need a real GUI or PowerShell, not our shell.

_macaron_platform() {
  case "$(uname -s)" in
    Darwin) echo "macos" ;;
    Linux)  echo "linux" ;;
    MINGW*|MSYS*|CYGWIN*) echo "windows" ;;
    *)      echo "unknown" ;;
  esac
}

_macaron_node_hint() {
  case "$(_macaron_platform)" in
    macos)   cat >&2 <<'EOF'
[macaron] Install Node 22+ one of:
[macaron]   • brew install node                             # Homebrew
[macaron]   • curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/master/install.sh | bash
[macaron]     then: nvm install 22 && nvm use 22
[macaron]   • Or the LTS installer from https://nodejs.org
EOF
      ;;
    linux)   cat >&2 <<'EOF'
[macaron] Install Node 22+ one of:
[macaron]   • curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/master/install.sh | bash
[macaron]     then: nvm install 22 && nvm use 22
[macaron]   • curl -fsSL https://fnm.vercel.app/install | bash && fnm install 22
[macaron]   • Or your distro's package manager (apt / dnf / pacman)
EOF
      ;;
    windows) cat >&2 <<'EOF'
[macaron] Install Node 22+:
[macaron]   • winget install OpenJS.NodeJS.LTS
[macaron]   • Or the installer from https://nodejs.org
EOF
      ;;
    *) echo "[macaron] Install Node 22+ from https://nodejs.org" >&2 ;;
  esac
}

# Bootstrap nvm + Node 22 in-place. Only offered when: (a) platform supports
# it, (b) stdin is a TTY so the [Y/n] prompt actually reaches a human,
# (c) MACARON_AUTO_INSTALL_NODE!=0 (default = ask). If the user declines or
# nvm install fails, fall through to the manual hint. Sets NVM_DIR on the
# current shell so the subsequent `node --version` sees the new binary.
_macaron_try_install_node_via_nvm() {
  local reason="$1" # "missing" | "outdated"
  local plat; plat="$(_macaron_platform)"
  case "$plat" in macos|linux) ;; *) return 1 ;; esac
  case "${MACARON_AUTO_INSTALL_NODE:-1}" in 0|false|no) return 1 ;; esac
  if [ ! -t 0 ]; then
    echo "[macaron] non-interactive shell — skipping auto-install prompt" >&2
    return 1
  fi
  local prompt="[macaron] Node is $reason. Install Node 22 via nvm (self-contained under ~/.nvm, no sudo)? [Y/n] "
  local reply
  printf '%s' "$prompt" >&2
  if ! read -r reply; then return 1; fi
  case "${reply:-y}" in n|N|no|No) echo "[macaron] declined." >&2; return 1 ;; esac

  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    echo "[macaron] installing nvm to $NVM_DIR…" >&2
    if ! command -v curl >/dev/null 2>&1; then
      echo "[macaron] curl is required to download nvm — install curl first, or install Node manually." >&2
      return 1
    fi
    if ! curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash >&2; then
      echo "[macaron] nvm install failed. Falling back to manual instructions." >&2
      return 1
    fi
  fi
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh" >/dev/null 2>&1 || { echo "[macaron] failed to source nvm.sh" >&2; return 1; }
  echo "[macaron] installing Node 22 via nvm…" >&2
  nvm install 22 >&2 || { echo "[macaron] nvm install 22 failed" >&2; return 1; }
  nvm use 22 >&2 || { echo "[macaron] nvm use 22 failed" >&2; return 1; }
  # Prepend the newly-installed Node's bin dir to PATH for the rest of this
  # script (nvm modifies PATH only in the current shell; subshells inherit).
  local node_bin; node_bin="$(nvm which 22 2>/dev/null | head -1)"
  if [ -n "$node_bin" ]; then
    export PATH="$(dirname "$node_bin"):$PATH"
  fi
  command -v node >/dev/null 2>&1
}

if ! command -v node >/dev/null 2>&1; then
  echo "[macaron] Node not found." >&2
  if ! _macaron_try_install_node_via_nvm "missing"; then
    _macaron_node_hint
    exit 1
  fi
fi

_NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$_NODE_MAJOR" -lt 22 ]; then
  echo "[macaron] Node $_NODE_MAJOR is too old — Macaron needs Node 22+." >&2
  if ! _macaron_try_install_node_via_nvm "outdated"; then
    _macaron_node_hint
    exit 1
  fi
  # Re-check after nvm switch.
  _NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "$_NODE_MAJOR" -lt 22 ]; then
    echo "[macaron] still on Node $_NODE_MAJOR after nvm — open a new shell so PATH picks up the change, then retry." >&2
    exit 1
  fi
fi

# Codex plugin cache (~/.codex/plugins/cache/…) is NOT a stable working dir:
# Codex prunes/regenerates it on version sync, killing our node_modules +
# web/dist + server/dist and leaving a listening server pointing at
# nothing. Claude Code (~/.claude/plugins/cache/…) and Kimi Code
# (~/.kimi-code/plugins/… — installs run from a managed copy that gets
# replaced on plugin update) have the same class of behavior.
# Detect any of them and rsync source into a stable
# runtime dir under $HOME, then run install/build/launch from there.
DIR="$SRC_DIR"
_needs_mirror=0
case "$SRC_DIR" in
  *"/plugins/cache/"*|*"/.kimi-code/plugins/"*) _needs_mirror=1 ;;
esac
if [ "$_needs_mirror" = 1 ]; then
  # Version key: pull from package.json so parallel major bumps get
  # isolated runtime dirs. Fall back to a stable "current" if jq/node
  # aren't handy — the rsync below still keeps that dir up-to-date.
  _version=""
  if command -v node >/dev/null 2>&1; then
    _version="$(node -e 'try{console.log(require(process.argv[1]).version||"")}catch{}' "$SRC_DIR/package.json" 2>/dev/null || true)"
  fi
  [ -z "$_version" ] && _version="current"
  DIR="$HOME/.macaron/runtime/$_version"
  mkdir -p "$DIR"
  echo "[macaron] plugin cache dir is not persistent — mirroring to $DIR" >&2
  # rsync source (fast: excludes generated dirs). Preserves mtimes so the
  # rebuild-on-source-change check downstream still fires correctly.
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete \
      --exclude='.git' \
      --exclude='node_modules' \
      --exclude='web/dist' \
      --exclude='server/dist' \
      --exclude='shared/dist' \
      --exclude='.macaron-install-marker' \
      "$SRC_DIR/" "$DIR/"
  else
    # Fallback: cp -R (slower first sync, but rsync should exist on macOS).
    # Preserve node_modules/dist that already exist in $DIR by copying
    # only non-generated top-levels.
    for _item in "$SRC_DIR"/*; do
      _base="$(basename "$_item")"
      case "$_base" in
        node_modules|.git) continue ;;
      esac
      cp -R "$_item" "$DIR/" 2>/dev/null || true
    done
  fi
fi

# Snapshot caller-provided MACARON_* env before sourcing .env so a stale
# .env in the plugin cache can't clobber an explicit override (e.g.
# `MACARON_ENGINE=claude bash start.sh` from the /macaron command).
_CALLER_ENGINE="${MACARON_ENGINE-}"
_CALLER_PORT="${MACARON_PORT-}"
_CALLER_FOREGROUND="${MACARON_FOREGROUND-}"

if [ -f "$DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$DIR/.env"
  set +a
fi

[ -n "$_CALLER_ENGINE" ] && MACARON_ENGINE="$_CALLER_ENGINE"
[ -n "$_CALLER_PORT" ] && MACARON_PORT="$_CALLER_PORT"
[ -n "$_CALLER_FOREGROUND" ] && MACARON_FOREGROUND="$_CALLER_FOREGROUND"

ENGINE="${MACARON_ENGINE:-claude}"
case "$ENGINE" in
  codex) PORT="${MACARON_PORT:-7979}" ;;
  kimi)  PORT="${MACARON_PORT:-7980}" ;;
  *)     PORT="${MACARON_PORT:-7878}" ;;
esac
FOREGROUND="${MACARON_FOREGROUND:-0}"

WEB_DIST="$DIR/web/dist"
SERVER_DIST="$DIR/server/dist/index.js"

# --- pnpm via corepack --------------------------------------------------

# Node 22 ships corepack, which auto-materialises the pnpm binary from the
# `packageManager` field in package.json. Prefer it over any globally
# installed pnpm so the version is consistent across machines.
_GLOBAL_PNPM="$(command -v pnpm 2>/dev/null || true)"
_PNPM=""
_PNPM_FIX="pnpm"
if command -v corepack >/dev/null 2>&1; then
  # corepack enable is idempotent; --install-directory ensures we don't
  # need root privileges.
  _COREPACK_BIN="$DIR/node_modules/.corepack-bin"
  mkdir -p "$_COREPACK_BIN"
  corepack enable --install-directory "$_COREPACK_BIN" pnpm >/dev/null 2>&1 || true
  # Prepend the corepack shim dir so `pnpm` resolves to the pinned version.
  # Some Corepack builds do not create a shim here unless global pnpm is
  # already installed, so create a local fallback wrapper for package scripts.
  if [ ! -x "$_COREPACK_BIN/pnpm" ]; then
    cat > "$_COREPACK_BIN/pnpm" <<'EOF'
#!/usr/bin/env bash
exec corepack pnpm "$@"
EOF
    chmod +x "$_COREPACK_BIN/pnpm"
  fi
  export PATH="$_COREPACK_BIN:$PATH"
  _PNPM_FIX="corepack pnpm"
  if pnpm --version >/dev/null 2>&1; then
    _PNPM="pnpm"
  elif [ -z "${COREPACK_INTEGRITY_KEYS+x}" ]; then
    # Older Corepack builds can reject newer pnpm signing keys. If that is the
    # only blocker, disable the stale key check for this launcher process.
    export COREPACK_INTEGRITY_KEYS=0
    _PNPM_FIX="COREPACK_INTEGRITY_KEYS=0 corepack pnpm"
    if pnpm --version >/dev/null 2>&1; then
      _PNPM="pnpm"
    fi
  fi
fi
if [ -z "$_PNPM" ] && [ -n "$_GLOBAL_PNPM" ]; then
  _PNPM="$_GLOBAL_PNPM"
  _PNPM_FIX="$_GLOBAL_PNPM"
fi

if [ -z "$_PNPM" ]; then
  cat >&2 <<EOF
[macaron] neither \`corepack\` (Node 22+) nor a global \`pnpm\` is available.
[macaron] fix: install Node 22+ (corepack ships with it) or run
[macaron]      \`npm install -g pnpm@10.28.2\` and retry.
EOF
  exit 1
fi

# --- install ------------------------------------------------------------

# Marker file records the mtime of pnpm-lock.yaml at last successful
# install. If the lockfile is newer than the marker, node_modules is
# stale and we reinstall.
_INSTALL_MARKER="$DIR/node_modules/.macaron-install-marker"
needs_install=0
if [ ! -d "$DIR/node_modules" ] || [ ! -f "$_INSTALL_MARKER" ]; then
  needs_install=1
elif [ "$DIR/pnpm-lock.yaml" -nt "$_INSTALL_MARKER" ]; then
  needs_install=1
fi

if [ "$needs_install" = 1 ]; then
  echo "[macaron] installing workspace deps via pnpm (one-time, ~60s)…" >&2
  # First try frozen-lockfile — fast, reproducible, matches the committed
  # lockfile. Fall back to a full resolve if frozen fails (usually because
  # the lockfile drifted after a manual dep bump the user hasn't run
  # `pnpm install` for yet).
  if ! (cd "$DIR" && "$_PNPM" install --frozen-lockfile 2>&1); then
    echo "[macaron] frozen install failed — retrying without --frozen-lockfile" >&2
    if ! (cd "$DIR" && "$_PNPM" install 2>&1); then
      cat >&2 <<EOF
[macaron] pnpm install failed.
[macaron] fix: cd "$DIR" && rm -rf node_modules && $_PNPM_FIX install
[macaron] if that still fails, the pnpm-lock.yaml may be corrupt; open
[macaron] an issue at https://github.com/MindLab-Research/macaron-artifacts/issues
EOF
      exit 1
    fi
  fi
  mkdir -p "$DIR/node_modules"
  touch "$_INSTALL_MARKER"
fi

# --- build --------------------------------------------------------------

# Rebuild only when dist is missing or a source file is newer than the
# current bundle. The mtime check is fast even on cold NFS mounts because
# `find … -print -quit` stops at the first match.
needs_build=0
if [ ! -f "$SERVER_DIST" ] || [ ! -f "$WEB_DIST/index.html" ]; then
  needs_build=1
elif [ -n "$(find "$DIR/web/src" "$DIR/server/src" "$DIR/shared/src" \
       -newer "$WEB_DIST/index.html" -type f -print -quit 2>/dev/null)" ]; then
  needs_build=1
fi

# A `pnpm bundle` / prepack run leaves dist/index.js as a self-contained bun
# bundle that inlines server sources. tsc's incremental build only re-emits
# changed files and never overwrites that entry, so a stale bundle would be
# served forever ("build succeeded" but nothing changed). Detect the bundle
# marker (__require shim) and force a full tsc re-emit.
if grep -q '__require' "$SERVER_DIST" 2>/dev/null; then
  rm -f "$DIR/server/tsconfig.tsbuildinfo"
  needs_build=1
fi

if [ "$needs_build" = 1 ]; then
  echo "[macaron] building (~30s)…" >&2
  if ! (cd "$DIR" && "$_PNPM" run build 2>&1); then
    cat >&2 <<EOF
[macaron] build failed. Common causes and fixes:
[macaron]  1. Node version — this project needs Node 22+; check with \`node --version\`.
[macaron]  2. Stale install — try:
[macaron]        cd "$DIR" && rm -rf node_modules && $_PNPM_FIX install && $_PNPM_FIX run build
[macaron]  3. Read the build output above for the specific error and share it in an issue.
EOF
    exit 1
  fi
fi

# --- launch -------------------------------------------------------------

# Kill any prior instance bound to this port.
if command -v lsof >/dev/null 2>&1; then
  PIDS="$(lsof -ti :"$PORT" 2>/dev/null || true)"
  if [ -n "$PIDS" ]; then
    echo "[macaron] killing existing process on port $PORT: $PIDS" >&2
    kill -9 $PIDS 2>/dev/null || true
    sleep 0.3
  fi
fi

LOG="/tmp/macaron-plugin.log"
cd "$DIR"

export MACARON_ENGINE="$ENGINE"
export MACARON_PORT="$PORT"

if [ "$FOREGROUND" = "1" ]; then
  # Foreground path: async health-check probe prints the URL once the
  # server responds, THEN exec node so this shell becomes the server.
  # Used by the Codex plugin because its Bash tool kills backgrounded
  # children when the outer script returns.
  (
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      sleep 0.5
      if curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
        echo "Macaron WebUI (engine=$ENGINE): http://localhost:$PORT"
        exit 0
      fi
    done
    echo "[macaron] server didn't answer /api/health within 5s" >&2
  ) &
  exec node "$SERVER_DIST"
else
  # Background path: keeps Claude's /macaron command returning quickly
  # so it can echo the URL and continue the assistant turn.
  nohup node "$SERVER_DIST" > "$LOG" 2>&1 &
  SERVER_PID=$!
  disown "$SERVER_PID" 2>/dev/null || true

  for _ in 1 2 3 4 5 6; do
    sleep 0.5
    if curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
      break
    fi
  done

  echo "Macaron WebUI (engine=$ENGINE): http://localhost:$PORT"
  echo "PID: $SERVER_PID  (log: $LOG)"
fi
