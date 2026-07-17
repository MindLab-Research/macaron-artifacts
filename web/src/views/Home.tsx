// Home ("/") — a Session-shaped landing that fills the right pane. Empty
// canvas above, a composer at the bottom that mirrors the in-session composer
// pixel-for-pixel and behaviour-for-behaviour (slash palette, @file mentions,
// image chips with paste/drop, isolate toggle, permission chip, IME + history
// nav). First send stashes the prompt (plus images/isolate/permissionMode) via
// setPendingPrompt(project, ...) and navigates to /w/<project>, where the
// Session component's seed effect picks the payload up and auto-sends against
// the exact same setup — so nothing the user configured on the landing gets
// lost across the route change.

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, type SlashCommand } from '../lib/api';
import type { Workspace } from '@macaron/shared';
import { ArrowUp, ChevronDown, Paperclip, X } from 'lucide-react';
import { setPendingPrompt, type PendingImage } from '../lib/newSession';
import { startNewSession } from '../lib/liveStore';
import { SlashPalette } from '../components/SlashPalette';
import { useFileMention } from '../components/MentionPopup';
import { useToast } from '../components/Toast';
import { loadHistory } from '../lib/history';
import { StatusBar, type PermissionMode } from '../components/StatusBar';

type AttachedImage = { id: string; name: string; mimeType: string; dataUrl: string };
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export function Home() {
  const navigate = useNavigate();
  const toast = useToast();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [project, setProject] = useState<string>('');
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');

  // Session-composer-parity state.
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const composingRef = useRef(false);
  const compositionEndedAtRef = useRef(0);
  const [images, setImages] = useState<AttachedImage[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('default');
  // Seed the landing's permission chip from the global default so a fresh
  // visit reflects whatever the user set in Settings > Permissions. Guarded
  // by a "touched" ref so an async settings load can't stomp a manual pick.
  const permissionModeTouchedRef = useRef(false);
  useEffect(() => {
    let alive = true;
    api.settings().then((s) => {
      if (!alive || permissionModeTouchedRef.current) return;
      setPermissionMode(s.defaultPermissionMode);
    }).catch(() => {/* keep 'default' */});
    return () => { alive = false; };
  }, []);
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  const [slashIdx, setSlashIdx] = useState(0);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState<number | null>(null);
  const draftInputRef = useRef<string>('');

  const mention = useFileMention({ project, value: input, setValue: setInput, textareaRef, composingRef });

  // Load workspaces on mount, defaulting to the most-recently-active one so
  // a fresh visit lands where the user was last working.
  useEffect(() => {
    api.workspaces()
      .then((r) => {
        setWorkspaces(r.workspaces);
        if (r.workspaces.length > 0) {
          setProject((p) => p || r.workspaces[0]!.project);
        }
      })
      .catch((e) => setError((e as Error).message));
  }, []);

  useEffect(() => {
    queueMicrotask(() => textareaRef.current?.focus());
  }, []);

  // Slash-command list + prompt history are per-project — refetch whenever the
  // target workspace changes so the palette / arrow-up recall match what the
  // Session view would show for the same project.
  useEffect(() => {
    if (!project) { setCommands([]); return; }
    let alive = true;
    api.commands(project).then((r) => { if (alive) setCommands(r.commands); }).catch(() => {});
    return () => { alive = false; };
  }, [project]);
  useEffect(() => {
    setHistory(project ? loadHistory(project) : []);
    setHistoryIdx(null);
    draftInputRef.current = '';
  }, [project]);

  // ---- Image attachment: paste / drop / picker all funnel through addFiles.
  const addFiles = useCallback(async (files: FileList | File[]) => {
    const accepted: AttachedImage[] = [];
    for (const f of Array.from(files)) {
      if (!f.type.startsWith('image/')) continue;
      if (f.size > MAX_IMAGE_BYTES) {
        toast(`${f.name}: too big (>${(MAX_IMAGE_BYTES / 1024 / 1024).toFixed(0)} MB)`);
        continue;
      }
      const dataUrl: string = await new Promise<string>((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(String(r.result || ''));
        r.onerror = () => rej(r.error);
        r.readAsDataURL(f);
      }).catch((e) => { toast(`${f.name}: read failed (${(e as Error).message})`); return ''; });
      if (!dataUrl) continue;
      accepted.push({
        id: `img-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        name: f.name,
        mimeType: f.type,
        dataUrl,
      });
    }
    if (accepted.length) setImages((cur) => [...cur, ...accepted]);
  }, [toast]);

  // ---- Slash palette derivation (bare `/word`, matches Session behaviour).
  const slashQuery = input.startsWith('/') && !input.includes(' ') ? input.slice(1) : null;
  const filteredCommands = useMemo(() => {
    if (slashQuery === null) return [];
    const q = slashQuery.toLowerCase();
    return commands.filter(
      (c) => c.name.toLowerCase().includes(q) || (c.namespace ?? '').toLowerCase().includes(q),
    );
  }, [commands, slashQuery]);
  const paletteOpen = slashQuery !== null && filteredCommands.length > 0;
  useEffect(() => { setSlashIdx(0); }, [slashQuery]);

  const pickCommand = useCallback((cmd: SlashCommand) => {
    setInput(`/${cmd.name} `);
    setHistoryIdx(null);
  }, []);

  const submit = async () => {
    const t = input.trim();
    if ((!t && images.length === 0) || sending) return;
    if (!project) {
      setError('Pick or create a workspace first.');
      return;
    }
    setSending(true);
    setError('');
    const seedImages: PendingImage[] = images.map((img) => ({
      id: img.id,
      name: img.name,
      mimeType: img.mimeType,
      dataUrl: img.dataUrl,
    }));
    // Start the session directly from Home so we can navigate straight to
    // the real sid — no draft-tile promote → remount flash. The POST
    // populates the live module store; Session mounts once against the
    // real sid and subscribeLive picks up the buffered stream.
    try {
      const newSid = await startNewSession(project, {
        text: t,
        permissionMode,
        images: seedImages.length ? seedImages.map((i) => ({ mimeType: i.mimeType, dataUrl: i.dataUrl })) : undefined,
      });
      navigate(
        `/w/${encodeURIComponent(project)}/s/${encodeURIComponent(newSid)}`,
        { state: { pending: true } },
      );
    } catch (e) {
      // Fall back to the seed-prompt path so the user's typing isn't lost:
      // stash the prompt + attachments, jump to the workspace, and let the
      // draft tile retry from scratch.
      setPendingPrompt(project, t, {
        auto: true,
        images: seedImages.length ? seedImages : undefined,
        permissionMode,
      });
      navigate(`/w/${encodeURIComponent(project)}`);
      setError((e as Error).message);
    }
  };

  const handlePaletteKey = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (e.nativeEvent.isComposing || composingRef.current) return false;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSlashIdx((i) => Math.min(i + 1, filteredCommands.length - 1));
      return true;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSlashIdx((i) => Math.max(i - 1, 0));
      return true;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      const cmd = filteredCommands[slashIdx];
      if (cmd) {
        e.preventDefault();
        pickCommand(cmd);
        return true;
      }
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      setInput((v) => (v.startsWith('/') && !v.includes(' ') ? v + ' ' : v));
      return true;
    }
    return false;
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (paletteOpen && handlePaletteKey(e)) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      // IME safety: swallow the Enter that just confirmed a CJK candidate so
      // it doesn't double as a submit.
      if (e.nativeEvent.isComposing || composingRef.current || e.keyCode === 229) return;
      if (compositionEndedAtRef.current > 0 && performance.now() - compositionEndedAtRef.current < 80) {
        e.preventDefault();
        return;
      }
    }
    if (mention.onKeyDown(e)) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
      return;
    }
    // Shell-style history navigation — ArrowUp when the textarea is empty or
    // the caret is at position 0 recalls an earlier prompt; Escape bails back
    // to the draft the user was typing.
    if (e.key === 'ArrowUp') {
      const ta = e.currentTarget;
      const canEnter = historyIdx !== null || input === '' || ta.selectionStart === 0;
      if (!canEnter || history.length === 0) return;
      e.preventDefault();
      const nextIdx = historyIdx === null ? 0 : Math.min(historyIdx + 1, history.length - 1);
      if (historyIdx === null) draftInputRef.current = input;
      setHistoryIdx(nextIdx);
      setInput(history[history.length - 1 - nextIdx]!);
      return;
    }
    if (e.key === 'ArrowDown' && historyIdx !== null) {
      e.preventDefault();
      const nextIdx = historyIdx - 1;
      if (nextIdx < 0) {
        setHistoryIdx(null);
        setInput(draftInputRef.current);
      } else {
        setHistoryIdx(nextIdx);
        setInput(history[history.length - 1 - nextIdx]!);
      }
      return;
    }
    if (e.key === 'Escape' && historyIdx !== null) {
      e.preventDefault();
      setHistoryIdx(null);
      setInput(draftInputRef.current);
    }
  };

  const canSubmit = (input.trim().length > 0 || images.length > 0) && !!project && !sending;

  const activeWorkspace = workspaces.find((w) => w.project === project);
  const projectName = activeWorkspace?.name || project || '';

  return (
    <div className="home-view">
      <div className="home-inner">
        <h1 className="home-title">What can I help with?</h1>
        <p className="home-sub">
          Type a prompt and press Enter. Macaron will open the target workspace and start a fresh session there.
        </p>

        <form
          className={`session-input home-session-input${dragOver ? ' drag-over' : ''}`}
          onSubmit={(e) => { e.preventDefault(); submit(); }}
          onDragOver={(e) => { e.preventDefault(); if (!dragOver) setDragOver(true); }}
          onDragLeave={(e) => { if (e.currentTarget === e.target) setDragOver(false); }}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            if (e.dataTransfer.files?.length) void addFiles(e.dataTransfer.files);
          }}
        >
          {images.length > 0 && (
            <div className="img-chips">
              {images.map((img) => (
                <div key={img.id} className="img-chip" title={img.name}>
                  <img src={img.dataUrl} alt={img.name} />
                  <button
                    type="button"
                    className="img-chip-x"
                    onClick={() => setImages((cur) => cur.filter((c) => c.id !== img.id))}
                    aria-label="Remove image"
                  >
                    <X size={14} aria-hidden="true" />
                  </button>
                </div>
              ))}
            </div>
          )}
          {paletteOpen && (
            <SlashPalette
              commands={filteredCommands}
              activeIndex={slashIdx}
              onPick={pickCommand}
              onHover={setSlashIdx}
            />
          )}
          <div className="mention-anchor">
            {mention.popup}
            <textarea
              ref={textareaRef}
              rows={3}
              placeholder="Ask anything, or paste a task…"
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                if (historyIdx !== null) setHistoryIdx(null);
                mention.refresh();
              }}
              onSelect={() => mention.refresh()}
              onCompositionStart={() => { composingRef.current = true; }}
              onCompositionEnd={() => {
                composingRef.current = false;
                compositionEndedAtRef.current = performance.now();
              }}
              onPaste={(e) => {
                const files: File[] = [];
                for (const item of Array.from(e.clipboardData.items)) {
                  if (item.kind === 'file') {
                    const f = item.getAsFile();
                    if (f && f.type.startsWith('image/')) files.push(f);
                  }
                }
                if (files.length) { e.preventDefault(); void addFiles(files); }
              }}
              onKeyDown={onKey}
            />
          </div>
          <div className="session-input-tools">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files) void addFiles(e.target.files);
                e.target.value = '';
              }}
            />
            <button
              type="button"
              className="icon-btn"
              title="Attach image"
              aria-label="Attach image"
              onClick={() => fileInputRef.current?.click()}
            >
              <Paperclip size={16} strokeWidth={2} aria-hidden="true" />
            </button>
            {/* Workspace switcher styled as a provider-chip pill — same visual
                vocabulary as the permission chip in the StatusBar so the two
                pickers read as siblings. No leading label; the workspace name
                is enough context. */}
            <div className="provider-chip home-ws-chip" title={`Workspace · ${projectName || 'none'}`}>
              <span className="provider-chip-label">{projectName || 'No workspaces yet'}</span>
              <ChevronDown className="provider-chip-caret" size={8} strokeWidth={2.5} aria-hidden="true" />
              <select
                className="provider-chip-select"
                value={project}
                onChange={(e) => setProject(e.target.value)}
                disabled={workspaces.length === 0}
                aria-label="Target workspace"
              >
                {workspaces.length === 0 && <option value="">No workspaces yet</option>}
                {workspaces.map((w) => (
                  <option key={w.project} value={w.project}>{w.name}</option>
                ))}
              </select>
            </div>
            <div className="session-input-spacer" />
            <button
              className="primary send-btn"
              type="submit"
              disabled={!canSubmit}
              aria-label={sending ? 'Opening…' : 'Send'}
              title={sending ? 'Opening…' : 'Send (Enter)'}
            >
              <ArrowUp size={14} strokeWidth={2.4} aria-hidden="true" />
            </button>
          </div>
        </form>
        {/* Full Session StatusBar — mounted 1:1 so the landing reads with the
            same identity + permission + env chrome as an in-session view.
            Context / usage rows collapse themselves when there's no data yet
            (fresh landing has no assistant turn), so what shows up is the
            provider chip, project name, CLAUDE.md / MCP counters if the
            active workspace resolves them, and the permission chip. */}
        <StatusBar
          projectName={projectName}
          permissionMode={permissionMode}
          onPermissionChange={(v) => { permissionModeTouchedRef.current = true; setPermissionMode(v); }}
          sending={sending}
          currentTodo={null}
        />
        {error && <p className="home-error">{error}</p>}
      </div>
    </div>
  );
}
