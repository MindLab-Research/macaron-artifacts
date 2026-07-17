// Catalogue for the keyboard shortcuts macaron actually binds.
// The which-key-style help sheet (components/ShortcutsHelp.tsx) renders straight
// from this list. Add a shortcut here the moment you wire one up in the UI so the
// discoverability surface stays in sync with the handlers.
//
// The handlers themselves still live next to the behaviour they trigger
// (composer send / history in views/Session.tsx, the Shift+Tab permission cycle
// there too); this registry is the catalogue, not a dispatch layer.

export type Shortcut = {
  /** Key combo, one token per <kbd>. e.g. ['Shift', 'Enter']. */
  keys: string[];
  description: string;
};

export type ShortcutGroup = {
  title: string;
  items: Shortcut[];
};

export const SHORTCUTS: ShortcutGroup[] = [
  {
    title: 'Composer',
    items: [
      { keys: ['Enter'], description: 'Send message' },
      { keys: ['Shift', 'Enter'], description: 'New line' },
      { keys: ['↑'], description: 'Recall previous prompt (when empty or cursor at start)' },
      { keys: ['↓'], description: 'Next prompt in history' },
      { keys: ['Esc'], description: 'Exit history navigation, restore draft' },
    ],
  },
  {
    title: 'Session',
    items: [
      { keys: ['Shift', 'Tab'], description: 'Cycle permission mode: ask → accept edits → plan → bypass' },
    ],
  },
  {
    title: 'General',
    items: [
      { keys: ['?'], description: 'Toggle this shortcuts help' },
      { keys: ['Esc'], description: 'Close this dialog' },
    ],
  },
];
