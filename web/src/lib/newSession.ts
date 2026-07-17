// Carries the directory picked in the Sidebar to the point where the first
// message actually creates the session (Session.tsx's isNew send path). These
// live in different components across a route change, so a module-level map —
// same idiom as liveStore/canvas — is the simplest hand-off.

// claude-cli encodes a cwd to its ~/.claude/projects dir name by replacing
// every non-alphanumeric char with '-'. We mirror it so a freshly picked
// folder maps to the same project key the SDK will file the jsonl under.
export function encodeClaudeProjectName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

const PENDING_TTL_MS = 10 * 60_000;
const pending = new Map<string, { cwd: string; expiresAt: number }>(); // encoded project -> chosen abs cwd

export function setPendingCwd(project: string, cwd: string): void {
  pending.set(project, { cwd, expiresAt: Date.now() + PENDING_TTL_MS });
}

export function peekPendingCwd(project: string): string | undefined {
  const v = pending.get(project);
  if (!v) return undefined;
  if (v.expiresAt > Date.now()) return v.cwd;
  pending.delete(project);
  return undefined;
}

export function takePendingCwd(project: string): string | undefined {
  const v = peekPendingCwd(project);
  pending.delete(project);
  return v;
}

// Pending seed prompt — set when a Demos-page card or the Home landing wants
// to open a new session with a preloaded first message. Consumed once by
// Session's isNew branch; auto-sent so the user sees the render immediately.
//
// `images` / `isolate` / `permissionMode` let the Home composer forward the
// same knobs the Session composer exposes (attach, worktree, permission chip)
// so the first turn starts with the setup the user picked on the landing.
export type PendingImage = { id?: string; name?: string; mimeType: string; dataUrl: string };
export type PendingPermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';
export type PendingSeed = {
  text: string;
  auto: boolean;
  images?: PendingImage[];
  isolate?: boolean;
  permissionMode?: PendingPermissionMode;
};

const pendingPrompt = new Map<string, PendingSeed & { expiresAt: number }>();

export function setPendingPrompt(
  project: string,
  text: string,
  opts?: {
    auto?: boolean;
    images?: PendingImage[];
    isolate?: boolean;
    permissionMode?: PendingPermissionMode;
  },
): void {
  pendingPrompt.set(project, {
    text,
    auto: opts?.auto ?? true,
    images: opts?.images,
    isolate: opts?.isolate,
    permissionMode: opts?.permissionMode,
    expiresAt: Date.now() + PENDING_TTL_MS,
  });
}

export function takePendingPrompt(project: string): PendingSeed | undefined {
  const v = pendingPrompt.get(project);
  if (!v) return undefined;
  pendingPrompt.delete(project);
  if (v.expiresAt <= Date.now()) return undefined;
  const { expiresAt: _e, ...seed } = v;
  return seed;
}

export function peekPendingPrompt(project: string): PendingSeed | undefined {
  const v = pendingPrompt.get(project);
  if (!v || v.expiresAt <= Date.now()) return undefined;
  const { expiresAt: _e, ...seed } = v;
  return seed;
}
