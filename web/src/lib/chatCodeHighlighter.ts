import { CodeToTokenTransformStream, type RecallToken } from '@shikijs/stream';
import { createHighlighterCore, type HighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import type { LanguageRegistration, ThemedToken } from 'shiki';
import vitesseLight from 'shiki/themes/vitesse-light.mjs';
import vitesseDark from 'shiki/themes/vitesse-dark.mjs';

export type ChatCodeLanguage = string;
export type ChatCodeToken = ThemedToken | RecallToken;
export type ChatCodeTokenStream = ReadableStream<ChatCodeToken>;

type ChatCodeDeltaController = { stream: ChatCodeTokenStream; push: (delta: string) => void; close: () => void };
type LanguageModule = { default: LanguageRegistration[] };

// Dual themes so code blocks follow the app's light/dark toggle. Shiki emits the
// default (light) color inline plus a `--shiki-dark` CSS var per token; chat-code.css
// swaps to the dark var under :root[data-theme="dark"].
const CHAT_CODE_THEMES = { light: 'vitesse-light', dark: 'vitesse-dark' } as const;
const CHAT_CODE_THEME_KEY = `${CHAT_CODE_THEMES.light}|${CHAT_CODE_THEMES.dark}`;
const CODE_HTML_CACHE_LIMIT = 24;

// Curated allowlist: only these grammars ship, each as its own lazily-imported chunk.
// Switching off `shiki/bundle/web` drops the full registry + Oniguruma WASM from the
// build; the JS regex engine covers everything here. Add a language by dropping one
// `shiki/langs/<id>.mjs` loader in — unknown fence hints fall back to plain text.
const CHAT_CODE_LANGUAGE_LOADERS: Record<string, () => Promise<LanguageModule>> = {
  javascript: () => import('shiki/langs/javascript.mjs'),
  typescript: () => import('shiki/langs/typescript.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  jsonc: () => import('shiki/langs/jsonc.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
  toml: () => import('shiki/langs/toml.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  scss: () => import('shiki/langs/scss.mjs'),
  less: () => import('shiki/langs/less.mjs'),
  xml: () => import('shiki/langs/xml.mjs'),
  bash: () => import('shiki/langs/bash.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  java: () => import('shiki/langs/java.mjs'),
  kotlin: () => import('shiki/langs/kotlin.mjs'),
  swift: () => import('shiki/langs/swift.mjs'),
  c: () => import('shiki/langs/c.mjs'),
  cpp: () => import('shiki/langs/cpp.mjs'),
  csharp: () => import('shiki/langs/csharp.mjs'),
  php: () => import('shiki/langs/php.mjs'),
  ruby: () => import('shiki/langs/ruby.mjs'),
  dart: () => import('shiki/langs/dart.mjs'),
  lua: () => import('shiki/langs/lua.mjs'),
  dockerfile: () => import('shiki/langs/dockerfile.mjs'),
  diff: () => import('shiki/langs/diff.mjs'),
  ini: () => import('shiki/langs/ini.mjs'),
  graphql: () => import('shiki/langs/graphql.mjs'),
  vue: () => import('shiki/langs/vue.mjs'),
  svelte: () => import('shiki/langs/svelte.mjs'),
  astro: () => import('shiki/langs/astro.mjs'),
  makefile: () => import('shiki/langs/makefile.mjs'),
  proto: () => import('shiki/langs/proto.mjs'),
};

// Loose fence hints models emit ("js", "shell", "golang", "c++") → canonical loader id.
const CHAT_CODE_LANGUAGE_ALIASES: Record<string, string> = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', node: 'javascript',
  ts: 'typescript', mts: 'typescript', cts: 'typescript',
  yml: 'yaml',
  md: 'markdown', markdown: 'markdown',
  sh: 'bash', shell: 'bash', shellscript: 'bash', zsh: 'bash', console: 'bash',
  py: 'python', python3: 'python',
  golang: 'go',
  rs: 'rust',
  'c++': 'cpp', 'c#': 'csharp', cs: 'csharp',
  htm: 'html', xhtml: 'xml', svg: 'xml',
  rb: 'ruby',
  dockerfile: 'dockerfile', docker: 'dockerfile',
  patch: 'diff',
  kt: 'kotlin', kts: 'kotlin',
  gql: 'graphql',
  protobuf: 'proto',
  make: 'makefile',
};

let highlighterPromise: Promise<HighlighterCore> | null = null;
const languageLoadPromises = new Map<string, Promise<boolean>>();
const codeHtmlCache = new Map<string, string>();

const getHighlighter = () =>
  (highlighterPromise ??= createHighlighterCore({ langs: [], themes: [vitesseLight, vitesseDark], engine: createJavaScriptRegexEngine() }));

// Resolve to a loader id we ship a grammar for, or `text` (no highlight). Because
// callers pass the resolved id straight to Shiki, only ids with a loader survive.
export function resolveChatCodeLanguage(language?: string): ChatCodeLanguage {
  const normalized = language?.trim().toLowerCase();
  if (!normalized) return 'text';
  const canonical = CHAT_CODE_LANGUAGE_ALIASES[normalized] ?? normalized;
  return canonical in CHAT_CODE_LANGUAGE_LOADERS ? canonical : 'text';
}

// Returns the effective lang to hand Shiki: the requested one once its grammar loads,
// else `text` so an unknown/failed grammar renders as uncolored plain text instead of throwing.
async function ensureLanguageLoaded(highlighter: HighlighterCore, language: ChatCodeLanguage): Promise<ChatCodeLanguage> {
  if (language === 'text' || highlighter.getLoadedLanguages().includes(language)) return language;
  const loader = CHAT_CODE_LANGUAGE_LOADERS[language];
  if (!loader) return 'text';

  let loadPromise = languageLoadPromises.get(language);
  if (!loadPromise) {
    loadPromise = loader().then(
      (module) => highlighter.loadLanguage(module.default).then(() => true),
      () => false,
    );
    languageLoadPromises.set(language, loadPromise);
  }
  return (await loadPromise) ? language : 'text';
}

function getCodeHtmlCacheKey(code: string, language: ChatCodeLanguage) {
  return `${CHAT_CODE_THEME_KEY}\0${language}\0${code}`;
}

export async function renderChatCodeToHtml(code: string, language: ChatCodeLanguage) {
  const cacheKey = getCodeHtmlCacheKey(code, language);
  const cached = codeHtmlCache.get(cacheKey);
  if (cached) {
    codeHtmlCache.delete(cacheKey);
    codeHtmlCache.set(cacheKey, cached);
    return cached;
  }

  const highlighter = await getHighlighter();
  const lang = await ensureLanguageLoaded(highlighter, language);
  const html = highlighter.codeToHtml(code, { lang, themes: CHAT_CODE_THEMES, defaultColor: 'light' });
  codeHtmlCache.set(cacheKey, html);
  if (codeHtmlCache.size > CODE_HTML_CACHE_LIMIT) {
    const oldestKey = codeHtmlCache.keys().next().value;
    if (oldestKey) codeHtmlCache.delete(oldestKey);
  }
  return html;
}

export function createChatCodeDeltaStream(language: ChatCodeLanguage): ChatCodeDeltaController {
  let sourceController: ReadableStreamDefaultController<string> | null = null;
  const source = new ReadableStream<string>({ start(controller) { sourceController = controller; } });

  const stream = new ReadableStream<ChatCodeToken>({
    async start(controller) {
      try {
        const highlighter = await getHighlighter();
        const lang = await ensureLanguageLoaded(highlighter, language);
        // The source buffers deltas immediately, so chunks pushed before Shiki boots still replay in order.
        const tokenStream = source.pipeThrough(
          new CodeToTokenTransformStream({ highlighter, lang, themes: CHAT_CODE_THEMES, defaultColor: 'light', allowRecalls: true }),
        );
        const reader = tokenStream.getReader();
        let next = await reader.read();
        while (!next.done) {
          controller.enqueue(next.value);
          next = await reader.read();
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });

  return {
    stream,
    push(delta) { if (sourceController && delta) sourceController.enqueue(delta); },
    close() {
      if (!sourceController) return;
      sourceController.close();
      sourceController = null;
    },
  };
}
