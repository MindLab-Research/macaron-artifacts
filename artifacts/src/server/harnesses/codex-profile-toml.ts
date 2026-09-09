import { getStaticTOMLValue, parseTOML, type AST } from 'toml-eslint-parser';

export function parseCodexToml(source: string): Record<string, unknown> {
  try { return getStaticTOMLValue(parseTOML(source)) as Record<string, unknown>; }
  catch { throw new Error('The Codex configuration contains invalid TOML'); }
}

export function tomlLiteral(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(tomlLiteral).join(', ')}]`;
  if (value && typeof value === 'object') return `{ ${Object.entries(value).map(([key, item]) => `${tomlKey(key)} = ${tomlLiteral(item)}`).join(', ')} }`;
  throw new Error('Unsupported Codex configuration value');
}

function tomlKey(value: string) { return /^[\w-]+$/.test(value) ? value : JSON.stringify(value); }
function keyParts(key: AST.TOMLKey) { return key.keys.map(part => part.type === 'TOMLBare' ? part.name : part.value); }
function prefix(parent: (string | number)[], path: string[]) { return parent.every((key, index) => key === path[index]); }
type Entry = { path: (string | number)[]; node: AST.TOMLKeyValue; parent?: AST.TOMLInlineTable };

/** Edit AST ranges instead of stringifying the document: comments, auth and unfamiliar settings belong to the user. */
export function editCodexToml(source: string, path: string[], value: unknown): string {
  const ast = parseTOML(source), entries: Entry[] = [], tables: AST.TOMLTable[] = [];
  const visit = (body: AST.TOMLKeyValue[], parentPath: (string | number)[], parent?: AST.TOMLInlineTable) => {
    for (const node of body) {
      const itemPath = [...parentPath, ...keyParts(node.key)];
      entries.push({ path: itemPath, node, parent });
      if (node.value.type === 'TOMLInlineTable') visit(node.value.body, itemPath, node.value);
    }
  };
  for (const node of ast.body[0].body) {
    if (node.type === 'TOMLKeyValue') visit([node], []);
    else { tables.push(node); visit(node.body, node.resolvedKey); }
  }
  const match = entries.find(entry => entry.path.length === path.length && prefix(entry.path, path));
  if (match) {
    if (value !== undefined) return source.slice(0, match.node.value.range[0]) + tomlLiteral(value) + source.slice(match.node.value.range[1]);
    const ranges = [match.node.range];
    if (match.parent) {
      const siblings = match.parent.body, index = siblings.indexOf(match.node), next = siblings[index + 1], previous = siblings[index - 1];
      const comma = ast.tokens.find(token => token.value === ',' && (next ? token.range[0] >= match.node.range[1] && token.range[1] <= next.range[0] : previous && token.range[0] >= previous.range[1] && token.range[1] <= match.node.range[0]));
      if (comma) ranges.push(comma.range);
    }
    return ranges.sort((a, b) => b[0] - a[0]).reduce((text, [start, end]) => text.slice(0, start) + text.slice(end), source);
  }
  if (value === undefined) return source;
  const inline = entries.filter(entry => entry.node.value.type === 'TOMLInlineTable' && prefix(entry.path, path)).sort((a, b) => b.path.length - a.path.length)[0];
  const literal = tomlLiteral(value);
  if (inline) {
    const node = inline.node.value as AST.TOMLInlineTable, at = node.range[1] - 1;
    const tail = ast.tokens.filter(token => token.range[0] > (node.body.at(-1)?.range[1] ?? node.range[0]) && token.range[1] <= at);
    const separator = node.body.length && !tail.some(token => token.value === ',') ? ',' : '';
    return source.slice(0, at) + `${separator} ${path.slice(inline.path.length).map(tomlKey).join('.')} = ${literal} ` + source.slice(at);
  }
  const table = tables.filter(node => node.kind === 'standard' && prefix(node.resolvedKey, path)).sort((a, b) => b.resolvedKey.length - a.resolvedKey.length)[0];
  const relative = path.slice(table?.resolvedKey.length ?? 0).map(tomlKey).join('.');
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const lineEnd = table ? source.indexOf('\n', table.key.range[1]) : -1;
  const at = table ? lineEnd < 0 ? source.length : lineEnd + 1 : tables[0]?.range[0] ?? source.length;
  return source.slice(0, at) + (at && source[at - 1] !== '\n' ? newline : '') + `${relative} = ${literal}${newline}` + source.slice(at);
}
