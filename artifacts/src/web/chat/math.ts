/** Normalize TeX delimiters before Markdown consumes their backslashes. Code, links, and existing $$ blocks stay literal. */
export function normalizeMath(text: string): string {
  if (!text.includes('\\[') && !text.includes('\\(')) return text;
  const protectedRanges: [number, number][] = [];
  const protect = (pattern: RegExp) => { for (const match of text.matchAll(pattern)) protectedRanges.push([match.index!, match.index! + match[0].length]); };
  protect(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g); protect(/<(?:code|pre|script|style)\b[\s\S]*?<\/(?:code|pre|script|style)>/gi); protect(/(^|\n)(?: {4}|\t)[^\n]*(?:\n|$)/g); protect(/(`+)[^`\n]*?\1/g); protect(/\[([^\]\n]|\\.)*\]\([^\)\n]*\)/g); protect(/\$\$[\s\S]*?(?:\$\$|$)/g); protectedRanges.sort((a, b) => a[0] - b[0]);
  let output = '', continuation = '', delimiter: ']' | ')' | undefined, range = 0;
  for (let index = 0; index < text.length;) {
    while (protectedRanges[range]?.[1] <= index) range++;
    const protectedRange = protectedRanges[range];
    if (!delimiter && protectedRange && index >= protectedRange[0]) { output += text.slice(index, protectedRange[1]); index = protectedRange[1]; continue; }
    const char = text[index], next = text[index + 1];
    if (!delimiter && char === '`') { output += text.slice(index); break; }
    if (char === '\\' && next === '\\') { output += '\\\\'; index += 2; continue; }
    if (!delimiter && char === '\\' && next === '`') { output += '\\`'; index += 2; continue; }
    if (char === '\\' && !delimiter && (next === '[' || next === '(')) {
      if (next === '[') { const line = text.slice(text.lastIndexOf('\n', index - 1) + 1, index); const prefix = /^(?:[ \t]*>[ \t]?)*[ \t]*/.exec(line)![0], marker = /^(?:[-+*]|\d+[.)])[ \t]+/.exec(line.slice(prefix.length))?.[0] ?? ''; continuation = prefix + ' '.repeat(marker.length); }
      delimiter = next === '[' ? ']' : ')'; output += next === '[' ? `${continuation ? `\n${continuation}` : ''}$$\n${continuation}` : '$$'; index += 2; continue;
    }
    if (char === '\\' && delimiter && next === delimiter) { output += delimiter === ']' ? `\n${continuation}$$\n${continuation}` : '$$'; delimiter = undefined; index += 2; continue; }
    output += char; index++;
  }
  return output;
}
