export const isArtifactEntry = (path: string) => /^\.artifacts\/(?:canvases\/)?[^/]+\.(?:ui4a\.)?tsx$/.test(path);

/** Tool inputs use native paths; browser selections use the workspace-relative keys from the artifact stream. */
export function artifactEntryPath(path: string, cwd: string): string | undefined {
  const normalize = (value: string) => {
    const parts: string[] = [];
    for (const part of value.replaceAll('\\', '/').split('/')) {
      if (part === '.') continue;
      if (part === '..') { if (!parts.length || parts.at(-1) === '') return undefined; parts.pop(); }
      else if (part || !parts.length) parts.push(part);
    }
    return parts.join('/').replace(/\/$/, '');
  };
  const base = normalize(cwd), native = normalize(path);
  if (base === undefined || native === undefined) return;
  const relative = /^(?:\/|[a-z]:\/)/i.test(native) ? native.startsWith(`${base}/`) ? native.slice(base.length + 1) : undefined : native;
  return relative && isArtifactEntry(relative) ? relative : undefined;
}
