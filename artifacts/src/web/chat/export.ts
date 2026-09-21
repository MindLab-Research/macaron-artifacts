import { snapshotDocument } from '../ui4a/export';
import { highlighter } from '../theme/themes';
import { initializeChatExport } from './export-runtime';
import { defaultUrlTransform } from 'streamdown';
import { randomUUID } from '../uuid';

export async function chatHtml(transcript: HTMLElement, title: string): Promise<string> {
  const output = snapshotDocument(transcript, title, 'chat');
  for (const wrapper of output.querySelectorAll<HTMLElement>('[data-export-link]')) {
    const button = wrapper.querySelector('button[data-streamdown="link"]');
    if (!button) continue;
    const link = output.createElement('a'); link.href = defaultUrlTransform(wrapper.dataset.exportLink!, 'href', { type: 'element', tagName: 'a', properties: {}, children: [] }) ?? ''; link.rel = 'noreferrer'; link.target = '_blank';
    link.className = button.className; link.dataset.streamdown = 'link'; link.append(...button.childNodes); button.replaceWith(link);
  }
  output.querySelectorAll('[data-streamdown="link-safety-modal"]').forEach(element => element.remove());
  for (const button of output.querySelectorAll('button')) {
    if (button.closest('.ui4a-surface') || button.matches('[data-export-toggle], [data-export-reasoning-toggle]')) continue;
    if (button.matches('[data-streamdown="link"]')) button.replaceWith(...button.childNodes); else button.remove();
  }
  // CodeBlock lazily highlights on intersection; closed tools must also export ready-to-read syntax.
  for (const pre of output.querySelectorAll<HTMLElement>('pre[data-code-language]')) {
    const code = pre.querySelector('code');
    if (!code) continue;
    const lang = pre.dataset.codeLanguage!, theme = pre.dataset.codeTheme!;
    const engine = await highlighter(lang, theme);
    const { tokens } = engine.codeToTokens(code.textContent ?? '', { lang, theme });
    code.replaceChildren();
    for (const [index, line] of tokens.entries()) {
      if (index) code.append('\n');
      for (const token of line) {
        const span = output.createElement('span'); span.textContent = token.content;
        if (token.color) span.style.color = token.color;
        if (token.fontStyle && (token.fontStyle & 1)) span.style.fontStyle = 'italic';
        if (token.fontStyle && (token.fontStyle & 2)) span.style.fontWeight = 'bold';
        code.append(span);
      }
    }
  }
  // Only this fixed transcript controller may execute; generated cards remain static and have no host bridge.
  const nonce = randomUUID();
  output.querySelector<HTMLMetaElement>('meta[http-equiv="Content-Security-Policy"]')!.content = `script-src 'nonce-${nonce}'; object-src 'none'; base-uri 'none'; form-action 'none'`;
  const script = output.createElement('script'); script.setAttribute('nonce', nonce); script.textContent = `(${initializeChatExport.toString()})();`; output.body.append(script);
  return `<!doctype html>\n${output.documentElement.outerHTML}`;
}
