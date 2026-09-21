import { StrictMode, useCallback, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { Field, Label, Select } from '@headlessui/react';
import { ReasoningExamples } from './components/chat/ReasoningExamples';
import { ThemeProvider, useTheme } from './theme/ThemeProvider';
import { THEME_OPTIONS, type ThemeId } from './theme/themes';
import 'virtual:uno.css';
import './styles.css';

const query = new URLSearchParams(location.search);
function ThemeControl() {
  const { appearance, select, setMode } = useTheme();
  const change = useCallback((id: ThemeId) => { const dark = THEME_OPTIONS.find(theme => theme.id === id)?.type === 'dark'; const slot = dark ? 'dark' : 'light'; select(slot, id); setMode(slot); }, [select, setMode]);
  useEffect(() => { const id = query.get('theme'); if (THEME_OPTIONS.some(theme => theme.id === id)) change(id as ThemeId); }, [change]);
  return <Field className="reasoning-examples-field"><Label>主题</Label><Select value={appearance.id} onChange={event => change(event.target.value as ThemeId)}>{THEME_OPTIONS.map(theme => <option key={theme.id} value={theme.id}>{theme.label}</option>)}</Select></Field>;
}

createRoot(document.getElementById('root')!).render(<StrictMode><ThemeProvider><ReasoningExamples initialCase={query.get('case') ?? undefined} initialState={query.get('state') ?? undefined} initialStep={Number(query.get('step') ?? 0)} themeControl={<ThemeControl />} /></ThemeProvider></StrictMode>);
