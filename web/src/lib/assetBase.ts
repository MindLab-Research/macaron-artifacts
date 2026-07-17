// Resolve a public/ asset path against the Vite base so it works both when the
// server serves the SPA at its own root (BASE_URL '/') and when the docs site
// HOSTS the bundle under /app/ (BASE_URL '/app/'). Vite rewrites bundled asset
// URLs automatically, but runtime string refs (import-map shims, the service
// worker, logos, the manifest) don't go through the bundler — they'd 404 under
// /app without this. Pass a root-relative path like '/genui-shim/react.mjs'.
export function assetUrl(path: string): string {
  const base = import.meta.env.BASE_URL; // '/' locally, '/app/' hosted
  return base.replace(/\/$/, '') + path;
}
