import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '../assets/fonts/jetbrains-maple-mono/jetbrains-maple-mono.css';
import '@xterm/xterm/css/xterm.css';
import {
  terminalStreamUrl,
  sendTerminalInput,
  sendTerminalResize,
} from '../lib/terminal';
import { openEventStream, type EventStreamHandle } from '../lib/eventStream';
import { useTheme, type ResolvedTheme } from '../lib/theme';

// Terminal palette per resolved theme. xterm's `theme` is a plain JS object
// (not a CSS custom property), so it can't follow [data-theme] automatically —
// pick from these concrete values keyed on `resolved`. Colors mirror the
// light/dark tokens in styles.css (surface-2 / text / accent / good / warn /
// bad) so the terminal blends with the surrounding UI in both modes.
const THEMES: Record<ResolvedTheme, Record<string, string>> = {
  light: {
    background: '#F5F4ED',
    foreground: '#3D3929',
    cursor: '#C96442',
    cursorAccent: '#F5F4ED',
    selectionBackground: 'rgba(201, 100, 66, 0.22)',
    black: '#3D3929', brightBlack: '#8A8473',
    red: '#C0524A', brightRed: '#C0524A',
    green: '#5A8B5A', brightGreen: '#5A8B5A',
    yellow: '#B88A3A', brightYellow: '#B88A3A',
    blue: '#4A6FA5', brightBlue: '#4A6FA5',
    magenta: '#9A5BA5', brightMagenta: '#9A5BA5',
    cyan: '#3F8A8A', brightCyan: '#3F8A8A',
    white: '#5D584A', brightWhite: '#3D3929',
  },
  dark: {
    background: '#2C2B26',
    foreground: '#EDEAE0',
    cursor: '#E08159',
    cursorAccent: '#2C2B26',
    selectionBackground: 'rgba(224, 129, 89, 0.24)',
    black: '#1F1E1B', brightBlack: '#6E6A5C',
    red: '#E0736B', brightRed: '#E0736B',
    green: '#7FB279', brightGreen: '#7FB279',
    yellow: '#D4A857', brightYellow: '#D4A857',
    blue: '#6A93C4', brightBlue: '#6A93C4',
    magenta: '#B47BB4', brightMagenta: '#B47BB4',
    cyan: '#5AA4A4', brightCyan: '#5AA4A4',
    white: '#C9C4B5', brightWhite: '#EDEAE0',
  },
};

// xterm measures text with OffscreenCanvas in modern browsers; canvas font
// parsing does not resolve CSS custom properties, so keep this as a concrete
// monospace stack instead of var(--font-mono).
const TERMINAL_FONT_SIZE = 12;
const TERMINAL_FONT =
  '"JetBrains Maple Mono", "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';

async function loadTerminalFont(): Promise<void> {
  const fonts = document.fonts;
  if (!fonts?.load) return;
  await Promise.all([
    fonts.load(`${TERMINAL_FONT_SIZE}px "JetBrains Maple Mono"`),
    fonts.load(`700 ${TERMINAL_FONT_SIZE}px "JetBrains Maple Mono"`),
  ]);
}

export function Terminal({ project, sid, focused }: { project: string; sid: string; focused: boolean }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const { resolved } = useTheme();
  // Mirror `resolved` into a ref so the mount effect (which only depends on
  // project/sid — rebuilding the term on every theme flip would drop the
  // scrollback + reconnect the PTY) reads the latest theme at create time.
  const resolvedRef = useRef(resolved);
  resolvedRef.current = resolved;

  // Hot-swap the palette on a live term without remounting. The term is created
  // async (after the font loads), so guard — a flip during that window is
  // already baked into the create-time theme via resolvedRef.
  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = THEMES[resolved];
  }, [resolved]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let disposed = false;
    let raf = 0;
    let ro: ResizeObserver | null = null;
    let es: EventStreamHandle | null = null;
    let term: XTerm | null = null;

    void (async () => {
      try { await loadTerminalFont(); } catch { /* fall back to the font stack */ }
      if (disposed) return;

      term = new XTerm({
        fontFamily: TERMINAL_FONT,
        fontSize: TERMINAL_FONT_SIZE,
        theme: THEMES[resolvedRef.current],
        cursorBlink: true,
        scrollback: 5000,
        convertEol: false,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(host);
      fit.fit();
      termRef.current = term;
      fitRef.current = fit;
      if (focused) term.focus();

      const { cols, rows } = term;
      term.onData((data) => sendTerminalInput(project, sid, data));

      // history = full snapshot (reset+write, idempotent on reconnect);
      // output = incremental chunk; exit = dim footer.
      es = openEventStream(terminalStreamUrl(project, sid, cols, rows), (data) => {
        if (data === '[DONE]') { es?.close(); return; }
        let msg: { type?: string; data?: string; exitCode?: number; error?: string };
        try { msg = JSON.parse(data); } catch { return; }
        if (msg.type === 'history') { term?.reset(); if (msg.data) term?.write(msg.data); }
        else if (msg.type === 'output') term?.write(msg.data || '');
        else if (msg.type === 'exit') { term?.write(`\r\n\x1b[2m[process exited${msg.exitCode ? ` (${msg.exitCode})` : ''}]\x1b[0m\r\n`); es?.close(); }
        else if (msg.type === 'error') term?.write(`\r\n\x1b[31m${msg.error || 'error'}\x1b[0m\r\n`);
      });
      // Reconnects are useful while the PTY is alive; exit/[DONE] are terminal
      // states, so close the stream above to avoid respawning a shell.

      const doFit = () => {
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => {
          try { fit.fit(); } catch { /* detached */ }
          if (term?.cols && term.rows) sendTerminalResize(project, sid, term.cols, term.rows);
        });
      };
      ro = new ResizeObserver(doFit);
      ro.observe(host);
    })();

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      ro?.disconnect();
      es?.close();
      term?.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [project, sid]);

  // Focus the terminal when its tile gains focus.
  useEffect(() => {
    if (focused) termRef.current?.focus();
  }, [focused]);

  return <div className="term-host" ref={hostRef} />;
}
