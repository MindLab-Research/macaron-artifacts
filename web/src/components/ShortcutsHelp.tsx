import { useEffect, useRef, useState } from 'react';
import { hasActiveModal } from '../lib/modal';
import { SHORTCUTS } from '../lib/shortcuts';

// Which-key-style help sheet. Renderless until opened. Toggled by pressing `?`
// anywhere outside a text field, or by dispatching `macaron:shortcuts` (the
// sidebar affordance does this). Renders from the keyboard shortcut catalogue in
// lib/shortcuts.ts and reuses the .confirm-* modal chrome.

function isTypingTarget(el: EventTarget | null): boolean {
  const node = el as HTMLElement | null;
  if (!node) return false;
  const tag = node.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || node.isContentEditable;
}

export function ShortcutsHelp() {
  const [open, setOpen] = useState(false);
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && open) {
        e.preventDefault();
        setOpen(false);
        return;
      }
      // `?` is Shift+/ on most layouts — ignore it while typing so it stays a
      // literal character in the composer, and skip when other modifiers are held.
      if (e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey && !isTypingTarget(e.target)) {
        e.preventDefault();
        setOpen((v) => (v ? false : !hasActiveModal()));
      }
    };
    const onOpen = () => setOpen((v) => v || !hasActiveModal());
    window.addEventListener('keydown', onKey);
    window.addEventListener('macaron:shortcuts', onOpen);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('macaron:shortcuts', onOpen);
    };
  }, [open]);

  useEffect(() => {
    if (open) queueMicrotask(() => closeBtnRef.current?.focus());
  }, [open]);

  if (!open) return null;

  return (
    <div className="confirm-backdrop" onClick={() => setOpen(false)}>
      <div
        className="confirm-dialog shortcuts-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcuts-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div id="shortcuts-title" className="confirm-title">Keyboard shortcuts</div>
        <div className="shortcuts-groups">
          {SHORTCUTS.map((group) => (
            <div key={group.title} className="shortcuts-group">
              <div className="shortcuts-group-title">{group.title}</div>
              {group.items.map((s) => (
                <div key={s.description} className="shortcuts-row">
                  <span className="shortcuts-keys">
                    {s.keys.map((k, i) => (
                      <kbd key={i}>{k}</kbd>
                    ))}
                  </span>
                  <span className="shortcuts-desc">{s.description}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
        <div className="confirm-actions">
          <button ref={closeBtnRef} className="ghost" type="button" onClick={() => setOpen(false)}>Close</button>
        </div>
      </div>
    </div>
  );
}
