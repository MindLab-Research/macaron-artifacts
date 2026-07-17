import { useEffect } from 'react';
import { useSidebar } from 'fumadocs-ui/components/sidebar/base';

// Fumadocs ships no sidebar hotkey (only search's Ctrl/Cmd+K), so we register one
// the same way it does: a window keydown bound in an effect. Ctrl+B (Cmd+B on
// macOS) mirrors VS Code; preventDefault beats the browser's bookmark-bar default.
// Headless component — renders nothing, must sit inside DocsLayout so useSidebar()
// finds its provider.
export function SidebarHotkey() {
  const { mode, collapsed, setCollapsed, open, setOpen } = useSidebar();

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const mod = /Mac|iP(hone|ad|od)/.test(navigator.platform) ? e.metaKey : e.ctrlKey;
      if (!mod || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'b') return;

      // Don't hijack the shortcut while the user is typing.
      const el = document.activeElement;
      if (el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;

      e.preventDefault();
      if (mode === 'drawer') setOpen(!open);
      else setCollapsed(!collapsed);
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [mode, collapsed, open, setCollapsed, setOpen]);

  return null;
}
