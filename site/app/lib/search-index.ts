import { fromMarkdown } from 'mdast-util-from-markdown';
import { toString } from 'mdast-util-to-string';
import { mdxjs } from 'micromark-extension-mdxjs';
import { mdxFromMarkdown } from 'mdast-util-mdx';
import type { Nodes } from 'mdast';
import ts from 'typescript';
import type { source } from './source';

type Page = (typeof source)['$inferPage'];

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

// structure() encodes the two markdown-punctuation characters it needs to protect
// as NUMERIC entities: backtick (`&#x60;`) and asterisk (`&#x2A;`). Decode ONLY
// those two BEFORE the parse, so a decoded `*mcc*` is re-read as emphasis instead
// of surfacing literally. Every other entity — crucially a quote (`&#34;` / `&#x22;`
// / `&quot;`) that lives inside a JSX attribute — is left encoded here: decoding it
// up front would end an attribute string early and leak the tag's tail (`B">…`).
// The survivors are decoded post-parse (decodeContentEntities), as plain content.
function decodeMarkdownPunctEntities(input: string): string {
  return input.replace(/&#x0*(60|2[aA]);|&#0*(96|42);/g, (m) => (/60|96/.test(m) ? '`' : '*'));
}

// Decode the entities that are just content once tags are gone: named ones plus
// any leftover numeric. Runs AFTER the tag scanner and parse, so a decoded `<`/`>`
// is a searchable character, never re-interpreted as markup. An out-of-range or
// otherwise invalid numeric entity (`&#9999999999;`) is NOT a real code point —
// String.fromCodePoint would throw and abort the whole index build, so keep such a
// malformed entity as its literal source text instead.
function decodeContentEntities(input: string): string {
  const fromCode = (n: number, raw: string) => (Number.isFinite(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : raw);
  return input
    .replace(/&(amp|lt|gt|quot|apos);/g, (_, name: string) => NAMED_ENTITIES[name] ?? name)
    .replace(/&#x([0-9a-fA-F]+);/g, (m, hex) => fromCode(parseInt(hex, 16), m))
    .replace(/&#(\d+);/g, (m, dec) => fromCode(parseInt(dec, 10), m));
}

// Node types whose *own value* is markup, never searchable prose: raw HTML, MDX
// `{…}` expressions (including `{/* comments */}`), and ESM import/export lines.
// JSX element nodes (mdxJsxTextElement / mdxJsxFlowElement) are NOT dropped —
// their tag + attributes contribute no text, but their CHILDREN are the component
// body, which is real content (`<Callout>inner</Callout>` → `inner`).
const DROP_NODE_TYPES = new Set(['html', 'mdxFlowExpression', 'mdxTextExpression', 'mdxjsEsm']);

// Collect visible text from an mdast/mdxast tree, skipping markup-only nodes and
// recursing through JSX elements to keep their body text. Never inspects raw `<`
// runs by hand, so an intraword `_` or a `<`/`>` inside prose is untouched.
function nodeText(node: Nodes): string {
  if (DROP_NODE_TYPES.has(node.type)) return '';
  if ('children' in node && node.children.length > 0) return node.children.map(nodeText).join('');
  return 'value' in node ? node.value : '';
}

// structure() serializes a component tag it can't render into a chunk of plain text,
// and — because Fumadocs splits a flow component around any nested heading — often into
// a STANDALONE opening/closing residue that is not valid MDX on its own (`\<Tabs …>`, a
// lone `</Tabs>`, a `<>` / `</>` fragment boundary). The MDX parser throws on those, so
// they must be removed here, BEFORE the parse, WITHOUT touching a searchable `<` in prose.
//
// The genuinely ambiguous case — `<out disabled>` / `<const dataÉ="x">` / `<in title="x">`
// — is a valid JSX element AND a valid TS generic at the SAME time, so no per-chunk grammar
// oracle can separate the two. structure() hands us a stronger, cross-chunk signal: it emits
// a matching `</Name>` closing-residue chunk for every real flow component, but NEVER for a
// TS generic. So `closerNames` (every `</Name>` seen anywhere in the page's chunk stream) is
// the authority — if an opener's name is paired with a page closer, it is a component.
// Falling back to structural signals for the unpaired remainder:
//   - a `</Name>` / self-closing / fragment residue is always markup,
//   - an opener that is JSX-valid but not TS-valid, or that fills its whole chunk standalone,
//     is a split flow component,
//   - everything else (a bare `<T>`, an `a<b` comparison, a `<T, U = …>` generic) is prose.
// The scan is code-span, quote, template-literal, brace and entity aware, so a `>` hiding
// inside an attribute string / `{…}` / `` `…` `` can't end a tag early.
function stripComponentResidue(text: string, closerNames: Set<string>): string {
  // A JSX/TS name may start with a letter, `_`, `$` or any Unicode ID_Start, and continue
  // with those plus digits / `.` / `-`. structure() markdown-escapes a leading/embedded `_`
  // as `\_`, so a name char can arrive as a two-char `\x` — the *Len helpers report how many
  // source chars one logical name char spans (0 when it isn't one) so the scanner sees
  // through the escape and covers `µPanel` and other Unicode identifiers, not just `À-￿`.
  const NAME_START = /[\p{ID_Start}$_]/u;
  const NAME_CONT = /[\p{ID_Continue}$.-]/u;
  const nameStartLen = (p: number) => (text[p] === '\\' && NAME_START.test(text[p + 1] ?? '') ? 2 : NAME_START.test(text[p] ?? '') ? 1 : 0);
  const nameContLen = (p: number) => (text[p] === '\\' && NAME_CONT.test(text[p + 1] ?? '') ? 2 : NAME_CONT.test(text[p] ?? '') ? 1 : 0);
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    // A code span is verbatim: copy `…` runs (matching the opening fence length)
    // untouched so a `<version>` or `<T>` generic inside code is never scanned.
    if (c === '`') {
      let f = 0; while (text[i + f] === '`') f++;
      const fence = text.slice(i, i + f);
      const end = text.indexOf(fence, i + f);
      const stop = end === -1 ? text.length : end + f;
      out += text.slice(i, stop); i = stop; continue;
    }
    // Fragment boundaries `<>` / `</>` (possibly escaped `\<>`): pure markup, drop.
    const frag = /^\\?<\/?>/.exec(text.slice(i));
    if (frag) { out += ' '; i += frag[0].length; continue; }
    // An HTML comment (`<!-- … -->`) reached HERE is outside any code span (a code
    // span was copied verbatim by the branch above), so it is real markup — drop it.
    // A `<!-- … -->` INSIDE a code span never gets here, so its literal text stays.
    if (text.startsWith('<!--', i)) { const e = text.indexOf('-->', i + 4); out += ' '; i = e === -1 ? text.length : e + 3; continue; }
    // A tag opener: `<` or escaped `\<`, then optional `/`, then a JSX name start
    // (letter / `_` / `$` / Unicode ID_Start, possibly markdown-escaped as `\_`).
    const esc = c === '\\' && text[i + 1] === '<';
    const lt = esc ? i + 1 : i;
    const closing = text[lt + 1] === '/';
    const nameAt = lt + 1 + (closing ? 1 : 0);
    const opensTag = text[lt] === '<' && nameStartLen(nameAt) > 0;
    if (!opensTag) { out += c; i++; continue; }
    let j = nameAt;
    let nl: number;
    while ((nl = nameContLen(j)) > 0) j += nl;
    const name = deEscape(text.slice(nameAt, j)); // tag name, unescaped for the pairing lookup
    const paired = !closing && closerNames.has(name); // a `</name>` residue exists elsewhere in the page → component
    const glued = out.trim() !== ''; // real prose precedes this `<` in the same chunk
    // Scan to the terminating `>` at brace depth 0 so a `>` hidden in an attribute
    // string / `{…}` expression / `` `…` `` template can't end the tag early. structure()
    // markdown-escapes the JSX punctuation (`\{`, `\[`, `\<`), so a `\{` counts as a brace;
    // inside a quote / template a `\`-escape hides the next char, so a `\"` / escaped
    // backtick can't close the attribute string early. The tag body (`lt+1 … >`) is then
    // handed to opensJsxElement() for the JSX-vs-generic decision.
    let quote = '', brace = 0, closed = false, selfClose = false;
    let k = j;
    while (k < text.length) {
      const ch = text[k];
      if (quote) {
        if (ch === '\\') { k += 2; continue; } // escaped char inside a string/template
        if (ch === quote) quote = '';
        k++; continue;
      }
      if (ch === '\\' && /[<>{}[\]]/.test(text[k + 1] ?? '')) { // structure()'s markdown-escaped punctuation
        const p = text[k + 1];
        if (p === '{') brace++; else if (p === '}' && brace > 0) brace--;
        k += 2; continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') quote = ch;
      else if (ch === '{') brace++;
      else if (ch === '}' && brace > 0) brace--;
      else if (ch === '/' && !brace && text[k + 1] === '>') selfClose = true;
      else if (ch === '>' && !brace) { k++; closed = true; break; }
      k++;
    }
    // Lossy recovery: structure() drops backslashes inside an attribute string (`\"` → `"`),
    // which can desync the quote state machine so it never finds the real `>`. For a GLUED
    // paired opener (a confirmed component with real prose before it), retry with a naive
    // first unescaped `>` so the visible body/suffix after the tag survives. A STANDALONE
    // opener chunk is left unclosed on purpose — it is swallowed to end-of-chunk below.
    if (!closed && paired && glued) { let m = j; while (m < text.length) { if (text[m] === '>' && text[m - 1] !== '\\') { k = m + 1; closed = true; break; } m++; } }
    // The opener body is the tag name + attributes, up to (not including) the closing `>`.
    // A page closer pairs it (component); otherwise the grammars + standalone shape decide.
    const body = text.slice(lt + 1, closed ? k - 1 : k).replace(/\/\s*$/, '');
    const standalone = !glued && (!closed || text.slice(k).trim() === ''); // opener fills its whole chunk
    const isComponent = !closing && !selfClose && (paired || opensJsxElement(body, standalone));
    // An UNCLOSED opener is split-flow residue (strip to end) when it is confirmed a component
    // (name paired), or its body carries a JSX `attr={…}` / `{...spread}`, or it fills the whole
    // chunk and parses as JSX. A standalone prose generic (`\<T, U = "x">`) or a compact
    // `alpha\<needle remains body` comparison matches none, so it is kept verbatim.
    if (!closed && esc && (paired || looksLikeOpener(body) || (standalone && opensJsxElement(body, true)))) { i = text.length; out = out.trimEnd(); continue; }
    if (closed && (closing || selfClose || isComponent)) { out += ' '; i = k; continue; }
    // KEEP: this `<…>` is prose (a TS generic / type-argument / comparison / placeholder).
    // A multi-token body (`keyof X`, `T, U = …`, `a instanceof B`) or a qualified name
    // (`ns.Member`) parses as a JSX element downstream and would be silently dropped, so
    // emit its `<` as `&lt;` (decodeContentEntities restores a searchable `<`). A bare
    // single-name opener (`<T>`, `<version>`, and residual `<Step>` component markup) keeps
    // the old literal path — the parser drops the stray tag, matching prior behavior.
    if (closed && /[\s,=]|\.[A-Za-z_$]/.test(deEscape(body).trim())) { out += '&lt;'; i = lt + 1; continue; }
    out += c; i++;
  }
  return out;
}

// Classify a `<…>` opener body (everything after `<` up to but excluding the closing `>`,
// tag name included) as a JSX ELEMENT (strip) or as TypeScript / prose (keep), using the
// REAL grammars. This is the fallback for openers the caller could NOT settle by cross-chunk
// pairing (no matching `</Name>` residue in the page):
//   - The TypeScript parser decides whether the body is legal TS: a type-PARAMETER list
//     (`type _<B> = 0;`), a call's type ARGUMENTS (`f<B>();`, covering `keyof X` / `ns.Q`),
//     or a relational expression (`x = a<B>b;`, covering `a instanceof B`). Any clean → TS.
//   - The MDX grammar decides whether the body is a valid JSX opening element.
//   - Both can be true for a genuinely ambiguous body (`out disabled`, `const dataÉ="x"`).
//     Without a page closer to break the tie, `standalone` does: an opener that fills its
//     WHOLE chunk is split flow-component residue (structure() only emits a bare opener chunk
//     when it split a component around a nested heading), so strip it; an ambiguous body that
//     sits INSIDE prose is a generic, so keep it.
// structure() markdown-escapes JSX punctuation (`\<`, `\{`, `\_`, …); undo every such escape
// for the grammar probes (the caller still deletes from the original text).
function opensJsxElement(body: string, standalone: boolean): boolean {
  const inner = deEscape(body).replace(/\s+/g, ' ').trim();
  // `parseDiagnostics` is TS-internal (not on the public SourceFile type) but is the
  // cheapest syntactic-error signal without a full Program — cast to reach it.
  const clean = (src: string) => ((ts.createSourceFile('t.ts', src, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS) as ts.SourceFile & { parseDiagnostics?: unknown[] }).parseDiagnostics ?? []).length === 0;
  const tsValid = clean(`type _<${inner}> = 0;`) || clean(`f<${inner}>();`) || clean(`x = a<${inner}>b;`);
  try {
    let jsx = false;
    const walk = (n: { type: string; children?: unknown[] }) => { if (n.type.startsWith('mdxJsx')) jsx = true; for (const ch of (n.children ?? []) as typeof n[]) walk(ch); };
    walk(fromMarkdown(`<${inner} />`, { extensions: [mdxjs()], mdastExtensions: [mdxFromMarkdown()] }) as never);
    return jsx && (!tsValid || standalone); // JSX-shaped, and either not-TS or a whole-chunk opener residue
  } catch {
    return false;
  }
}

// Undo structure()'s markdown escaping of ANY punctuation (`\<`, `\{`, `\_`, `\-`, …) —
// a `\` before a non-alphanumeric, non-space char — so the grammar probes and opener
// sniff see the real tag text.
function deEscape(s: string): string {
  return s.replace(/\\([^0-9A-Za-z\s])/g, '$1');
}

// An UNCLOSED escaped opener is split-flow component residue only if its body actually
// looks like a JSX opening tag: it has an `attr={…}` JSX expression or a `{...spread}`.
// A standalone prose generic (`\<T, U = "x">`) or an `alpha\<needle …` comparison has
// neither, so we must NOT strip to end-of-chunk for those.
function looksLikeOpener(body: string): boolean {
  const inner = deEscape(body);
  return /[\w$]+=\{/.test(inner) || /\{\s*\.\.\./.test(inner);
}

// structuredData chunks carry raw markdown (inline-code backticks, **bold**,
// [text](url) links) plus, for content nested in MDX flow components, serialized
// tag residue like `</Step>` / `\<Tabs items=\{…}>` / `<>`. The previous regex
// stack destroyed technical identifiers — a generic `_…_` emphasis rule stripped
// the underscores out of `MACARON_CODEX_TRANSPORT`, `permission_request`, etc.
//
// Pipeline:
//  1. decodeMarkdownPunctEntities — decode ONLY structure()'s `&#x60;`/`&#x2A;`
//     (backtick/asterisk) so `*mcc*` re-reads as emphasis; leave attribute-quote
//     entities encoded so they can't end a JSX attribute early.
//  2. stripComponentResidue — remove standalone component residue (closing tags,
//     fragments, attributed/self-closing openers) that would otherwise throw the
//     MDX parser or leak, WITHOUT touching a prose `<T>` / `a<b` / code-span tag.
//  3. Parse the cleaned chunk into a real MDX AST and read text off the nodes, so
//     classification happens in the grammar, not by guessing on flattened text:
//       - CommonMark never treats intraword `_` as emphasis → identifiers survive.
//       - A `{/* … */}` comment / ESM line is an expression/esm node → dropped.
//       - A code-span generic (`` `<T>` ``) or compact comparison (`alpha<beta`)
//         is inlineCode/text → preserved verbatim.
//  4. Any chunk still not valid MDX (residual escapes, odd fragments) falls back to
//     a CommonMark parse; step 2 already removed the component markup, so nothing
//     tag-shaped remains to mis-handle.
export function sanitizeSearchText(input: string, closerNames: Set<string> = collectCloserNames([input])): string {
  // stripComponentResidue removes component markup — including HTML comments — with
  // code-span awareness, so a `<!-- … -->` literal inside `` `…` `` survives while a
  // real comment outside code is dropped. It runs on the raw (still entity-encoded)
  // chunk so a `>` hidden in an attribute entity can't end a tag early. closerNames is
  // the page-wide `</Name>` set so an opener split away from its closer still pairs.
  const cleaned = stripComponentResidue(decodeMarkdownPunctEntities(input), closerNames);
  let text: string;
  try {
    text = nodeText(fromMarkdown(cleaned, { extensions: [mdxjs()], mdastExtensions: [mdxFromMarkdown()] }));
  } catch {
    text = toString(fromMarkdown(cleaned), { includeHtml: false }).replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ');
  }
  return decodeContentEntities(text)
    // Drop stray backticks the AST left as literal text (a lone/unpaired `,
    // e.g. from a decoded `&#x60;`). Only backticks — never `_` or word chars —
    // so identifiers are untouched.
    .replace(/`+/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// Collect every component name that appears as a `</Name>` closing residue anywhere in a
// page's chunk stream (headings + contents). structure() emits one per real flow component
// but never for a TS generic, so this set is the cross-chunk authority that tells an
// ambiguous `<out …>` / `<const …>` opener apart from a same-named generic. Names are
// deEscaped (structure() writes `</\_Panel>`) so they match the opener's unescaped name.
export function collectCloserNames(chunks: Iterable<string>): Set<string> {
  const names = new Set<string>();
  for (const raw of chunks) for (const m of deEscape(raw).matchAll(/<\/\s*([^>\s/]+)\s*>/gu)) names.add(m[1]);
  return names;
}

// Custom buildIndex passed to createFromSource: same shape as fumadocs' default
// extractor, but every heading and content chunk is sanitized so the static
// search JSON holds clean prose instead of markdown/entities.
export async function buildIndex(page: Page) {
  const structuredData = await page.data.structuredData;
  // Precompute the page-wide `</Name>` set once from every chunk so each opener is
  // disambiguated against closers that structure() may have split into other chunks.
  const closerNames = collectCloserNames([...structuredData.headings, ...structuredData.contents].map((c) => c.content));
  return {
    id: page.url,
    title: page.data.title ?? '',
    description: page.data.description,
    url: page.url,
    structuredData: {
      headings: structuredData.headings.map((h) => ({ ...h, content: sanitizeSearchText(h.content, closerNames) })),
      contents: structuredData.contents.map((c) => ({ ...c, content: sanitizeSearchText(c.content, closerNames) })),
    },
  };
}
