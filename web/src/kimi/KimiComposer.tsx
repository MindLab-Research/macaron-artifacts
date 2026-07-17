import { useEffect, useRef } from 'react';
import { Square, ArrowUp } from 'lucide-react';
import { KimiProviderPicker } from './KimiProviderPicker';

// No image attach here (unlike the codex composer): `kimi -p` has no verified
// headless image input, so the server accepts but drops images — offering the
// button would silently discard user content.
export function KimiComposer({
  value,
  onChange,
  onSubmit,
  onStop,
  disabled,
  running,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onStop?: () => void;
  disabled?: boolean;
  running?: boolean;
  placeholder?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 220) + 'px';
  }, [value]);

  const key = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (!disabled && value.trim()) onSubmit();
    }
  };

  return (
    <div className="kx-composer-wrap">
      <div className="kx-composer">
        <div className="kx-composer-row">
          <textarea
            ref={ref}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={key}
            placeholder={placeholder ?? 'Message Kimi…'}
            rows={1}
          />
          {running && onStop ? (
            <button className="kx-send stop" onClick={onStop} title="Stop"><Square size={14} fill="currentColor" aria-hidden="true" /></button>
          ) : (
            <button
              className="kx-send"
              disabled={disabled || !value.trim()}
              onClick={onSubmit}
              title="Send (Enter)"
              aria-label="Send"
            ><ArrowUp size={16} aria-hidden="true" /></button>
          )}
        </div>
      </div>
      <div className="kx-composer-foot">
        <div className="kx-composer-pickers">
          <KimiProviderPicker />
        </div>
        <span className="kx-composer-hint">Enter to send · Shift+Enter for newline</span>
      </div>
    </div>
  );
}
