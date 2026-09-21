import { createHighlighterCore, type HighlighterCore, type ThemeRegistration } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import { bundledThemes, bundledThemesInfo, type BundledTheme } from 'shiki/themes';
import { readableSyntaxTheme, themePalette } from './palette';

export type ThemeId = 'playground' | BundledTheme;
export const THEME_OPTIONS: { id: ThemeId; label: string; type?: 'light' | 'dark' }[] = [
  { id: 'playground', label: 'Playground' },
  ...bundledThemesInfo.map(theme => ({ id: theme.id as BundledTheme, label: theme.displayName, type: theme.type })),
];
export function filterThemes(query: string) {
  const normalize = (value: string) => value.normalize('NFKD').replace(/\p{Diacritic}/gu, '').replace(/[-_]/g, ' ').toLowerCase().trim();
  const needle = normalize(query);
  return THEME_OPTIONS.filter(theme => normalize(`${theme.label} ${theme.id}`).includes(needle));
}
export type Appearance = { id: ThemeId; dark: boolean; syntax: string; revision: number };
export function themeAppearance(id: ThemeId, playgroundDark: boolean, revision: number): Appearance {
  const dark = id === 'playground' ? playgroundDark : THEME_OPTIONS.find(theme => theme.id === id)?.type === 'dark';
  return { id, dark, syntax: id === 'playground' ? dark ? 'vitesse-dark' : 'vitesse-light' : id, revision };
}
const THEME_PAIRS: [ThemeId, ThemeId][] = [
  ['catppuccin-latte', 'catppuccin-mocha'], ['rose-pine-dawn', 'rose-pine'], ['horizon-bright', 'horizon'], ['one-light', 'one-dark-pro'],
  ['slack-ochin', 'slack-dark'], ['kanagawa-lotus', 'kanagawa-wave'], ['material-theme-lighter', 'material-theme'], ['light-plus', 'dark-plus'],
];
const lightFamily: Partial<Record<ThemeId, ThemeId>> = { 'catppuccin-frappe': 'catppuccin-latte', 'catppuccin-macchiato': 'catppuccin-latte', 'rose-pine-moon': 'rose-pine-dawn', 'kanagawa-dragon': 'kanagawa-lotus', 'material-theme-darker': 'material-theme-lighter', 'material-theme-ocean': 'material-theme-lighter', 'material-theme-palenight': 'material-theme-lighter', 'ayu-mirage': 'ayu-light', 'vitesse-black': 'vitesse-light' };
export function oppositeTheme(id: ThemeId, dark: boolean): ThemeId | undefined {
  const pair = THEME_PAIRS.find(pair => pair.includes(id));
  const candidates = [pair?.[dark ? 1 : 0], !dark ? lightFamily[id] : undefined, id.replace(dark ? 'light' : 'dark', dark ? 'dark' : 'light'), id.replace(/-light$/, ''), `${id}-light`];
  return candidates.find(candidate => THEME_OPTIONS.some(theme => theme.id === candidate && theme.type === (dark ? 'dark' : 'light'))) as ThemeId | undefined;
}
const LANGUAGES = {
  tsx: () => import('@shikijs/langs/tsx'), typescript: () => import('@shikijs/langs/typescript'), javascript: () => import('@shikijs/langs/javascript'),
  json: () => import('@shikijs/langs/json'), css: () => import('@shikijs/langs/css'), html: () => import('@shikijs/langs/html'), markdown: () => import('@shikijs/langs/markdown'),
  bash: () => import('@shikijs/langs/bash'), yaml: () => import('@shikijs/langs/yaml'), diff: () => import('@shikijs/langs/diff'),
};
const ALIASES: Record<string, string> = { ts: 'typescript', js: 'javascript', jsx: 'tsx', md: 'markdown', sh: 'bash', shell: 'bash', zsh: 'bash', yml: 'yaml', txt: 'text', plaintext: 'text' };
export const normalizeLanguage = (language: string) => { const normalized = ALIASES[language] ?? language; return normalized in LANGUAGES ? normalized : 'text'; };
let core: Promise<HighlighterCore> | undefined;
const languageLoads = new Map<string, Promise<void>>();
const themeLoads = new Map<string, Promise<ThemeRegistration>>();
export const loadTheme = (name: string) => {
  let task = themeLoads.get(name);
  if (!task) {
    const loader = bundledThemes[name as BundledTheme];
    if (!loader) return Promise.reject(new Error(`Unknown Shiki theme: ${name}`));
    task = loader().then(module => module.default).catch(error => { themeLoads.delete(name); throw error; });
    themeLoads.set(name, task);
  }
  return task;
};

export async function highlighter(language: string, theme: string) {
  core ??= createHighlighterCore({ langs: [], themes: [], engine: createJavaScriptRegexEngine() });
  const engine = await core;
  const lang = normalizeLanguage(language);
  const jobs: Promise<unknown>[] = [];
  if (!engine.getLoadedThemes().includes(theme)) jobs.push(loadTheme(theme).then(value => engine.loadTheme(readableSyntaxTheme(value))));
  if (lang !== 'text' && !languageLoads.has(lang)) languageLoads.set(lang, LANGUAGES[lang as keyof typeof LANGUAGES]().then(module => engine.loadLanguage(module.default as never)).then(() => undefined));
  const languageJob = languageLoads.get(lang);
  if (languageJob) jobs.push(languageJob);
  await Promise.all(jobs);
  return engine;
}

export { themePalette } from './palette';

export function applyTheme(theme: ThemeRegistration, playground: boolean, dark: boolean) {
  const root = document.documentElement;
  root.dataset.theme = dark ? 'dark' : 'light';
  const palette = themePalette(theme, dark);
  // Playground remains the exact reference palette; its syntax still comes from Shiki's Vitesse.
  for (const [key, value] of Object.entries(palette)) playground && !['success', 'warn'].includes(key) ? root.style.removeProperty(`--${key}`) : root.style.setProperty(`--${key}`, value);
  root.style.colorScheme = dark ? 'dark' : 'light';
}
