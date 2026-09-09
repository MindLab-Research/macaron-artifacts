import { Combobox, ComboboxButton, ComboboxInput, ComboboxOption, ComboboxOptions, Dialog, DialogPanel, DialogTitle, Label, Radio, RadioGroup } from '@headlessui/react';
import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { useTheme } from '../theme/ThemeProvider';
import { matchingPreset, slotThemes, THEME_PRESETS, type ThemeMode, type ThemeSlot } from '../theme/preferences';
import { loadTheme, THEME_OPTIONS, themeAppearance, themePalette, type ThemeId } from '../theme/themes';
import { Icon } from './Icon';
import { Select } from './Select';

const MODES = [{ id: 'system', label: '自动', icon: 'monitor' }, { id: 'light', label: '浅色', icon: 'sun' }, { id: 'dark', label: '深色', icon: 'moon' }] as const;
const themeLabel = (id: ThemeId) => THEME_OPTIONS.find(theme => theme.id === id)?.label ?? id;

function ThemePreview({ slot, id }: { slot: ThemeSlot; id: ThemeId | null }) {
  const { preview } = useTheme();
  useEffect(() => { preview(slot, id); return () => preview(slot, null); }, [slot, id, preview]);
  return null;
}

function ThemeSample({ id, slot }: { id: ThemeId; slot: ThemeSlot }) {
  const [sample, setSample] = useState<{ id: ThemeId; style: CSSProperties }>({ id: 'playground', style: {} });
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let current = true;
    const next = themeAppearance(id, slot === 'dark', 0);
    setFailed(false);
    void loadTheme(next.syntax).then(theme => {
      if (!current) return;
      const entries = Object.entries(themePalette(theme, next.dark)).filter(([key]) => id !== 'playground' || ['success', 'warn'].includes(key));
      setSample({ id, style: Object.fromEntries(entries.map(([key, value]) => [`--${key}`, value])) });
    }, () => { if (current) setFailed(true); });
    return () => { current = false; };
  }, [id, slot]);
  return <>
    <div aria-hidden="true" data-sample={slot} data-palette={sample.id} data-theme={slot} style={{ ...sample.style, colorScheme: slot }} className="theme-sample flex h-28 flex-col justify-between overflow-hidden rounded-lg border border-border bg-surface p-3 text-fg">
      <div className="flex items-center justify-between gap-2"><span className="text-lg font-medium">Aa</span><div className="flex gap-1.5">{['bg-series-1', 'bg-series-2', 'bg-series-3', 'bg-series-4'].map(color => <span key={color} className={`size-2.5 rounded-full ${color}`} />)}</div></div>
      <div className="flex items-center justify-between gap-2"><code className="min-w-0 truncate text-xs text-muted">{'<Canvas />'}</code><span className="grid size-7 shrink-0 place-items-center rounded-md bg-accent text-accent-fg"><Icon name="plus" className="size-3.5" /></span></div>
    </div>
    {failed ? <p role="status" className="mt-1 text-xs text-danger">预览加载失败</p> : null}
  </>;
}

function ThemePicker({ slot }: { slot: ThemeSlot }) {
  const { preferences, activeSlot, select, preview } = useTheme();
  const [query, setQuery] = useState('');
  const [pointer, setPointer] = useState(false);
  const [hoveredId, setHoveredId] = useState<ThemeId | null>(null);
  // Headless UI commits the active option on Tab by default; browsing must not silently save it.
  const tabbing = useRef(false);
  const inputId = useId(), helpId = useId();
  const label = slot === 'light' ? '浅色配色' : '深色配色';
  const options = slotThemes(slot, query);
  // Pointer-enter can precede Headless UI's active-option update; Enter must confirm the visible preview.
  return <Combobox as="div" className="min-w-0" value={preferences[slot]} onChange={id => { const choice = pointer ? hoveredId ?? id : id; if (choice && !tabbing.current) select(slot, choice); }} onClose={() => { setQuery(''); setHoveredId(null); setPointer(false); preview(slot, null); tabbing.current = false; }} immediate>
    {({ open, activeOption }) => {
      const previewId = open ? pointer ? hoveredId : activeOption as ThemeId | null : null;
      return <>
        <div className="mb-2 flex items-center justify-between gap-1"><label htmlFor={inputId} className="text-xs font-medium text-muted">{label}</label>{activeSlot === slot ? <span className="text-[10px] text-muted">当前</span> : null}</div>
        <ThemeSample slot={slot} id={previewId ?? preferences[slot]} />
        <div className="relative mt-2">
          <ComboboxInput id={inputId} aria-describedby={helpId} displayValue={themeLabel} title={themeLabel(preferences[slot])} onChange={event => { setQuery(event.target.value); setHoveredId(null); setPointer(false); }} onKeyDownCapture={event => { tabbing.current = event.key === 'Tab'; if (event.key !== 'Enter') { setHoveredId(null); setPointer(false); } }} placeholder="搜索配色…" className="interactive w-full min-w-0 rounded-lg border border-input-border bg-input-bg py-2 pr-8 pl-2.5 text-sm text-input-fg placeholder:text-input-placeholder focus:border-focus focus:outline-none" />
          <ComboboxButton aria-label={`浏览${label}`} className="interactive absolute inset-y-0 right-0 grid w-8 place-items-center rounded-r-lg text-muted hover:text-fg"><Icon name="chevronDown" className="size-3.5" /></ComboboxButton>
        </div>
        <span id={helpId} className="sr-only">搜索主题，用方向键或悬停预览，Enter 确认，Esc 或 Tab 取消。非当前模式只预览色样。</span>
        {open ? <ThemePreview slot={slot} id={previewId} /> : null}
        <ComboboxOptions anchor={{ to: 'bottom start', gap: 6, padding: 16 }} onPointerLeave={() => { setPointer(true); setHoveredId(null); }} className="z-50 max-h-[min(18rem,var(--anchor-max-height))] w-[var(--input-width)] min-w-60 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-lg border border-border bg-surface-2 p-1 shadow-xl outline-none">
          {options.map(theme => <ComboboxOption key={theme.id} value={theme.id} onPointerEnter={event => { if (event.pointerType !== 'touch') { setPointer(true); setHoveredId(theme.id); } }} className={({ focus }) => `interactive flex min-h-9 cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm data-[selected]:font-medium data-[selected]:text-fg ${(pointer ? hoveredId === theme.id : focus) ? 'bg-surface-3 text-fg' : 'text-muted'}`}>
            {({ selected }) => <><Icon name="check" className={`size-3 shrink-0 ${selected ? '' : 'opacity-0'}`} /><span className="min-w-0 break-words">{theme.label}</span></>}
          </ComboboxOption>)}
          {!options.length ? <p role="status" className="px-3 py-2 text-sm text-muted">没有匹配的主题</p> : null}
        </ComboboxOptions>
      </>;
    }}
  </Combobox>;
}

export function AppearanceDialog({ onClose }: { onClose: () => void }) {
  const { preferences, activeSlot, setMode, pair } = useTheme();
  const preset = matchingPreset(preferences);
  return <Dialog open onClose={onClose} className="relative z-50"><div className="fixed inset-0 bg-black/25" /><div className="fixed inset-0 flex items-center justify-center p-4"><DialogPanel className="max-h-[calc(100dvh-2rem)] w-full max-w-lg overflow-y-auto rounded-lg border border-border bg-surface p-5 text-fg shadow-2xl">
    <div className="mb-5 flex items-center justify-between"><DialogTitle className="text-base font-medium">外观</DialogTitle><button type="button" data-autofocus onClick={onClose} aria-label="关闭外观设置" className="interactive grid size-8 place-items-center rounded-lg text-muted hover:bg-surface-3 hover:text-fg"><Icon name="x" /></button></div>
    <RadioGroup value={preferences.mode} onChange={(mode: ThemeMode) => setMode(mode)} aria-orientation="horizontal">
      <Label className="sr-only">显示模式</Label>
      <div className="grid grid-cols-3 gap-1 rounded-lg bg-surface-2 p-1">{MODES.map(mode => <Radio key={mode.id} as="button" type="button" value={mode.id} aria-label={mode.id === 'system' ? '自动，跟随系统' : mode.label} className="interactive flex h-10 items-center justify-center gap-2 rounded-md text-sm text-muted data-[checked]:bg-accent data-[checked]:font-medium data-[checked]:text-accent-fg data-[checked]:hover:bg-accent-hover [&:not([data-checked]):hover]:bg-surface-3 [&:not([data-checked]):hover]:text-fg"><Icon name={mode.icon} />{mode.label}</Radio>)}</div>
    </RadioGroup>
    <div className="mt-5 flex items-center gap-4"><span className="shrink-0 text-xs font-medium text-muted">配色组合</span><div className="min-w-0 flex-1"><Select label="配色组合" value={preset?.id ?? 'custom'} options={[{ value: 'custom', label: '自定义', disabled: true }, ...THEME_PRESETS.map(item => ({ value: item.id, label: item.label }))]} onChange={id => { const choice = THEME_PRESETS.find(item => item.id === id); if (choice) pair(choice.light, choice.dark); }} /></div></div>
    <div className="mt-5 grid grid-cols-2 gap-4"><ThemePicker slot="light" /><ThemePicker slot="dark" /></div>
    <p role="status" className="mt-4 text-xs text-muted">{preferences.mode === 'system' ? `跟随系统 · 当前${activeSlot === 'dark' ? '深色' : '浅色'}` : `始终使用${activeSlot === 'dark' ? '深色' : '浅色'}`}</p>
  </DialogPanel></div></Dialog>;
}
