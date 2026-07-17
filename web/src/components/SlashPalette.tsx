import type { SlashCommand } from '../lib/api';

// Composer slash-command palette. Purely presentational: the parent owns the
// filtered list and the highlighted index (so the composer's existing onKey
// can drive ↑/↓/Enter without a second keyboard listener fighting it). Ported
// from fafawlf/claude-code-web's SlashPalette — floats above the input,
// substring filter, no wrap, click-or-Enter to pick.
export function SlashPalette({
  commands,
  activeIndex,
  onPick,
  onHover,
}: {
  commands: SlashCommand[];
  activeIndex: number;
  onPick: (cmd: SlashCommand) => void;
  onHover: (index: number) => void;
}) {
  if (commands.length === 0) return null;
  return (
    <div className="slash-palette" role="listbox">
      {commands.map((cmd, i) => (
        <button
          key={`${cmd.source}:${cmd.namespace ?? ''}:${cmd.name}`}
          type="button"
          role="option"
          aria-selected={i === activeIndex}
          className={'slash-item' + (i === activeIndex ? ' active' : '')}
          // onMouseDown (not onClick): fires before the textarea's blur, so
          // focus stays put and the pick lands while the palette is still open.
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(cmd);
          }}
          onMouseEnter={() => onHover(i)}
        >
          <span className="slash-name">/{cmd.name}</span>
          {cmd.namespace && <span className="slash-ns">{cmd.namespace}</span>}
          {cmd.argumentHint && <span className="slash-hint">{cmd.argumentHint}</span>}
          {cmd.description && <span className="slash-desc">{cmd.description}</span>}
          <span className="slash-source">{cmd.source}</span>
        </button>
      ))}
    </div>
  );
}
