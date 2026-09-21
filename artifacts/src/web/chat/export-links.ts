import { defaultRehypePlugins } from 'streamdown';

type Node = { type: string; tagName?: string; properties?: Record<string, unknown>; children?: Node[] };

/** Streamdown's link-safety button omits href; retain the sanitized destination without changing its live behavior. */
export function exportLinks() {
  return function visit(node: Node) {
    for (const child of node.children ?? []) visit(child);
    if (node.tagName !== 'a' || typeof node.properties?.href !== 'string') return;
    const link = { ...node };
    node.tagName = 'span'; node.properties = { 'data-export-link': node.properties.href }; node.children = [link];
  };
}

export const exportRehypePlugins = [...Object.values(defaultRehypePlugins), exportLinks];
