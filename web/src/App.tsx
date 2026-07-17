import { useEffect, useRef, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { Menu, X } from 'lucide-react';
import { Sidebar } from './components/Sidebar';
import { Toast } from './components/Toast';
import { NotifyStack } from './components/NotifyStack';
import { CommandPalette } from './components/CommandPalette';
import { SearchPalette } from './components/SearchPalette';
import { ShortcutsHelp } from './components/ShortcutsHelp';

export function App() {
  const [navOpen, setNavOpen] = useState(false);
  const location = useLocation();
  const closeRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const keepDrawerOpen = Boolean(
    (location.state as { keepClaudeDrawerOpen?: boolean } | null)?.keepClaudeDrawerOpen,
  );

  useEffect(() => {
    if (!keepDrawerOpen) setNavOpen(false);
  }, [location.pathname, keepDrawerOpen]);

  useEffect(() => {
    const onResize = () => {
      if (window.innerWidth > 768) setNavOpen(false);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    if (!navOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setNavOpen(false);
        return;
      }
      if (event.key !== 'Tab') return;
      const drawer = drawerRef.current;
      if (!drawer) return;
      const focusable = Array.from(drawer.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), select:not([disabled]), textarea:not([disabled]), input:not([disabled])',
      ));
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    closeRef.current?.focus();
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      if (window.innerWidth <= 768) toggleRef.current?.focus();
    };
  }, [navOpen]);

  return (
    <>
      {!navOpen && (
        <button
          ref={toggleRef}
          type="button"
          className="mobile-nav-toggle"
          aria-label="Open navigation"
          aria-controls="claude-navigation"
          aria-expanded="false"
          onClick={() => setNavOpen(true)}
        >
          <Menu size={20} aria-hidden="true" />
        </button>
      )}
      <div
        ref={drawerRef}
        id="claude-navigation"
        className={`sb-drawer${navOpen ? ' open' : ''}`}
        role={navOpen ? 'dialog' : undefined}
        aria-modal={navOpen || undefined}
        aria-label={navOpen ? 'Navigation' : undefined}
      >
        <Sidebar onNavigate={() => setNavOpen(false)} />
        <button
          ref={closeRef}
          type="button"
          className="mobile-nav-close"
          aria-label="Close navigation"
          onClick={() => setNavOpen(false)}
        >
          <X size={18} aria-hidden="true" />
        </button>
      </div>
      {navOpen && (
        <div
          className="sb-backdrop"
          role="presentation"
          onClick={() => setNavOpen(false)}
        />
      )}
      <main id="main" inert={navOpen} aria-hidden={navOpen || undefined}>
        <Outlet />
      </main>
      <Toast />
      <NotifyStack />
      <CommandPalette />
      <SearchPalette />
      <ShortcutsHelp />
    </>
  );
}
