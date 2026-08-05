import { useEffect, useMemo, useRef, useState } from 'react';
import { Paperclip, X, Square, ArrowUp } from 'lucide-react';
import { CodexProviderPicker } from './CodexProviderPicker';
import { CodexRuntimePicker } from './CodexRuntimePicker';
import type { CodexRuntimeOverride } from './api';
import { useFileMention } from '../components/MentionPopup';
import { SlashPalette } from '../components/SlashPalette';
import { api, type SlashCommand } from '../lib/api';

export type ComposerImage = { id: string; name: string; mimeType: string; dataUrl: string };

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export function CodexComposer({
  value,
  onChange,
  images,
  onImagesChange,
  onSubmit,
  onStop,
  disabled,
  running,
  placeholder,
  project,
  onRuntime,
}: {
  value: string;
  onChange: (v: string) => void;
  images: ComposerImage[];
  onImagesChange: (next: ComposerImage[]) => void;
  onSubmit: () => void;
  onStop?: () => void;
  disabled?: boolean;
  running?: boolean;
  placeholder?: string;
  project: string;
  onRuntime: (ov: CodexRuntimeOverride) => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const composingRef = useRef(false);
  const [dragOver, setDragOver] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 220) + 'px';
  }, [value]);

  // @-mention file picker (fuzzy search of the workspace's tracked files).
  // Same hook + popup as the Claude composer, so a Codex user typing `@foo`
  // gets the same live-filtered file list. Requires a project id — if the
  // composer is used outside a workspace (rare), the hook silently no-ops.
  const mention = useFileMention({
    project,
    value,
    setValue: onChange,
    textareaRef: ref,
    composingRef,
  });

  // Slash-command palette: same user-scope commands the Claude composer offers
  // (~/.claude/commands + workspace .claude/commands). Palette opens while the
  // input is a bare `/word` (no space yet); Enter picks the highlighted one.
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  const [slashIdx, setSlashIdx] = useState(0);
  useEffect(() => {
    let alive = true;
    api.commands(project).then((r) => { if (alive) setCommands(r.commands); }).catch(() => {});
    return () => { alive = false; };
  }, [project]);
  const slashQuery = value.startsWith('/') && !value.includes(' ') ? value.slice(1) : null;
  const filteredCommands = useMemo(() => {
    if (slashQuery === null) return [];
    const q = slashQuery.toLowerCase();
    return commands.filter((c) => c.name.toLowerCase().includes(q) || (c.namespace ?? '').toLowerCase().includes(q));
  }, [commands, slashQuery]);
  const paletteOpen = slashQuery !== null && filteredCommands.length > 0;
  useEffect(() => { setSlashIdx(0); }, [slashQuery]);
  const pickCommand = (cmd: SlashCommand) => {
    // Insert `/name ` (trailing space) — the trailing space closes the
    // palette (bare `/word` predicate goes false) AND readies args.
    onChange(`/${cmd.name} `);
  };
  const handlePaletteKey = (e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
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
      if (cmd) { e.preventDefault(); pickCommand(cmd); return true; }
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      onChange((value.startsWith('/') && !value.includes(' ') ? value + ' ' : value));
      return true;
    }
    return false;
  };

  const addFiles = async (files: FileList | File[]) => {
    const accepted: ComposerImage[] = [];
    for (const f of Array.from(files)) {
      if (!f.type.startsWith('image/') || f.size > MAX_IMAGE_BYTES) continue;
      const dataUrl = await new Promise<string>((res) => {
        const r = new FileReader();
        r.onload = () => res(String(r.result || ''));
        r.onerror = () => res('');
        r.readAsDataURL(f);
      });
      if (dataUrl) accepted.push({ id: `img-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name: f.name, mimeType: f.type, dataUrl });
    }
    if (accepted.length) onImagesChange([...images, ...accepted]);
  };

  const key = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Slash palette intercepts first (only fires when open with matches),
    // then @-mention popup, then the composer's own submit path — matches
    // Claude composer's precedence so behaviour is identical when both
    // popups happen to fight for the same key.
    if (paletteOpen && handlePaletteKey(e)) return;
    if (mention.onKeyDown(e)) return;
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (!disabled && (value.trim() || images.length)) onSubmit();
    }
  };

  return (
    <div className="cx-composer-wrap">
      <div
        className={'cx-composer' + (dragOver ? ' drag-over' : '')}
        onDragOver={(e) => { e.preventDefault(); if (!dragOver) setDragOver(true); }}
        onDragLeave={(e) => { if (e.currentTarget === e.target) setDragOver(false); }}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (e.dataTransfer.files?.length) void addFiles(e.dataTransfer.files);
        }}
      >
        {images.length > 0 && (
          <div className="cx-img-chips">
            {images.map((img) => (
              <div key={img.id} className="cx-img-chip" title={img.name}>
                <img src={img.dataUrl} alt={img.name} />
                <button
                  type="button"
                  className="cx-img-chip-x"
                  onClick={() => onImagesChange(images.filter((c) => c.id !== img.id))}
                  aria-label="Remove image"
                ><X size={14} aria-hidden="true" /></button>
              </div>
            ))}
          </div>
        )}
        <div className="cx-composer-row">
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => { if (e.target.files) void addFiles(e.target.files); e.target.value = ''; }}
          />
          <button
            className="cx-attach"
            type="button"
            onClick={() => fileRef.current?.click()}
            title="Attach image"
            aria-label="Attach image"
          >
            <Paperclip size={16} strokeWidth={2} aria-hidden="true" />
          </button>
          {paletteOpen && (
            <SlashPalette
              commands={filteredCommands}
              activeIndex={slashIdx}
              onPick={pickCommand}
              onHover={setSlashIdx}
            />
          )}
          {mention.popup}
          <textarea
            ref={ref}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={key}
            onCompositionStart={() => { composingRef.current = true; }}
            onCompositionEnd={() => { composingRef.current = false; }}
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
            placeholder={placeholder ?? 'Message Codex…'}
            rows={1}
          />
          {running && onStop ? (
            <button className="cx-send stop" onClick={onStop} title="Stop"><Square size={14} fill="currentColor" aria-hidden="true" /></button>
          ) : (
            <button
              className="cx-send"
              disabled={disabled || (!value.trim() && !images.length)}
              onClick={onSubmit}
              title="Send (Enter)"
              aria-label="Send"
            ><ArrowUp size={16} aria-hidden="true" /></button>
          )}
        </div>
      </div>
      <div className="cx-composer-foot">
        <div className="cx-composer-pickers">
          <CodexProviderPicker />
          <CodexRuntimePicker project={project} onChange={onRuntime} disabled={running} />
        </div>
        <span className="cx-composer-hint">Enter to send · Shift+Enter for newline</span>
      </div>
    </div>
  );
}
