export function ui4aPath(path: string): string {
  if (path.includes("\\") || path.includes("\0") || path.includes("?") || path.includes("#") || !path.startsWith(".artifacts/")) throw new Error("UI4A files must use a relative .artifacts/ path");
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "." || part === "") continue;
    if (part === "..") parts.pop(); else parts.push(part);
    if (parts[0] !== ".artifacts") throw new Error("UI4A files must stay inside .artifacts/");
  }
  if (parts.length < 2) throw new Error("Expected a file inside .artifacts/");
  return parts.join("/");
}

export function relativeUi4aPath(specifier: string, filename: string): string {
  return ui4aPath(`${filename.slice(0, filename.lastIndexOf("/") + 1)}${specifier}`);
}

import { apiUrl, connectionHeaders } from '../chat/connection';

export function createFileClient(sessionId: string, fetcher: typeof fetch = fetch) {
  const url = (path: string) => apiUrl(`/api/sessions/${encodeURIComponent(sessionId)}/files?path=${encodeURIComponent(ui4aPath(path))}`);
  const checked = async (response: Response, path: string) => {
    if (!response.ok) {
      const text = await response.text();
      let message = text;
      try { message = (JSON.parse(text) as { error?: string }).error ?? text; } catch { /* plain-text HTTP errors are also useful */ }
      throw Object.assign(new Error(`UI4A file ${path}: ${message || response.statusText}`), { status: response.status });
    }
    return response;
  };
  const requestHeaders = () => { const headers = connectionHeaders(); return headers.has('authorization') ? { headers } : undefined; };
  return {
    async readFile(path: string): Promise<string> { return (await checked(await fetcher(url(path), requestHeaders()), path)).text(); },
    async writeFile(path: string, content: string): Promise<void> {
      await checked(await fetcher(url(path), { method: "PUT", headers: connectionHeaders({ "content-type": "application/json" }), body: JSON.stringify({ content }) }), path);
    },
  };
}
