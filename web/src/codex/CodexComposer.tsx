import { useEffect, useRef, useState } from 'react';
import { Paperclip, X, Square, ArrowUp } from 'lucide-react';
import { CodexProviderPicker } from './CodexProviderPicker';
import { CodexRuntimePicker } from './CodexRuntimePicker';
import type { CodexRuntimeOverride } from './api';

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
  const [dragOver, setDragOver] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 220) + 'px';
  }, [value]);

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
          <textarea
            ref={ref}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={key}
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
