import { createContext, use, useEffect, useState, type ReactNode } from 'react';
import { useTheme } from 'fumadocs-ui/provider/base';
import { Popover, PopoverContent, PopoverTrigger } from 'fumadocs-ui/components/ui/popover';
import { Check, Moon, Palette, Sun } from 'lucide-react';
import { loadPalette, palettes, paletteFamily, paletteVariant, paletteVariables, type PaletteId } from '@/lib/palettes';

const KEY = 'macaron-artifacts:docs-palette:v1';
const PaletteContext = createContext<{ selected: PaletteId; select: (id: PaletteId) => void; error?: string } | null>(null);
export function PaletteProvider({ children }: { children: ReactNode }) {
  const [selected, select] = useState<PaletteId>('neutral');
  const [error, setError] = useState<string>();
  const { resolvedTheme } = useTheme();
  useEffect(() => { try { const family = paletteFamily(localStorage.getItem(KEY)); if (family) select(family); } catch { /* Optional browser preferences. */ } }, []);
  useEffect(() => {
    let current = true;
    const root = document.documentElement;
    const clear = () => { for (const name of [...root.style]) if (name.startsWith('--color-fd-')) root.style.removeProperty(name); root.style.removeProperty('--genui'); delete root.dataset.palette; };
    const variant = selected === 'neutral' ? undefined : paletteVariant(selected, resolvedTheme === 'dark' ? 'dark' : 'light');
    if (!variant) { clear(); setError(undefined); }
    else void loadPalette(variant).then(theme => {
      if (!current) return;
      clear();
      const variables = paletteVariables(theme);
      for (const [name, value] of Object.entries(variables)) root.style.setProperty(`--color-fd-${name}`, value);
      root.style.setProperty('--genui', variables.link);
      root.dataset.palette = variant;
      setError(undefined);
    }, reason => { if (current) setError(reason instanceof Error ? reason.message : 'Theme could not be loaded'); });
    return () => { current = false; };
  }, [selected, resolvedTheme]);
  const choose = (id: PaletteId) => { select(id); try { localStorage.setItem(KEY, id); } catch { /* Optional browser preferences. */ } };
  return <PaletteContext value={{ selected, select: choose, error }}>{children}</PaletteContext>;
}

export function PaletteSwitch({ className = '' }: { className?: string }) {
  const palette = use(PaletteContext);
  const { resolvedTheme, setTheme } = useTheme();
  if (!palette) return null;
  const toggle = () => {
    const dark = resolvedTheme === 'dark';
    setTheme(dark ? 'light' : 'dark');
  };
  return <div className={`site:inline-flex site:shrink-0 site:items-center site:gap-1 ${className}`}>
    {/* Keep both icons and labels in the prerendered HTML; next-themes sets the root class before hydration. */}
    <button type="button" title="Toggle appearance" onClick={toggle} className="site:grid site:size-8 site:place-items-center site:rounded-full site:text-fd-muted-foreground site:hover:bg-fd-accent site:focus-visible:outline-none site:focus-visible:ring-2 site:focus-visible:ring-fd-ring"><Sun aria-hidden="true" className="site:size-4 site:dark:hidden" /><Moon aria-hidden="true" className="site:hidden site:size-4 site:dark:block" /><span className="site:sr-only site:dark:hidden">Use dark appearance</span><span className="site:sr-only site:hidden site:dark:block">Use light appearance</span></button>
    <Popover><PopoverTrigger aria-label="Choose color theme" title="Choose color theme" className="site:grid site:size-8 site:place-items-center site:rounded-full site:text-fd-muted-foreground site:hover:bg-fd-accent site:focus-visible:outline-none site:focus-visible:ring-2 site:focus-visible:ring-fd-ring"><Palette className="site:size-4" /></PopoverTrigger><PopoverContent className="docs-palette-menu site:min-w-44 site:p-1" align="end"><div role="group" aria-label="Color theme" className="site:flex site:flex-col site:gap-0.5">{palettes.map(item => <button type="button" key={item.id} aria-pressed={palette.selected === item.id} onClick={() => palette.select(item.id)} className="site:flex site:items-center site:gap-2 site:rounded-lg site:px-2 site:py-1.5 site:text-left site:text-sm site:hover:bg-fd-accent site:hover:text-fd-accent-foreground site:focus-visible:outline-none site:focus-visible:ring-2 site:focus-visible:ring-fd-ring"><Check className={`site:size-3.5 ${palette.selected === item.id ? '' : 'site:invisible'}`} />{item.label}</button>)}</div>{palette.error ? <p role="alert" className="site:p-2 site:text-xs site:text-fd-error">{palette.error}</p> : null}</PopoverContent></Popover>
  </div>;
}
