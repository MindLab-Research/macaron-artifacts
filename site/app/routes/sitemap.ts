import { source } from '@/lib/source';
import { siteUrl } from '@/lib/shared';

export function loader() {
  const urls = ['/', ...source.getPages().map((page) => page.url)].map((path) => `<url><loc>${siteUrl}${path}</loc></url>`);
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.join('')}</urlset>\n`, { headers: { 'Content-Type': 'application/xml' } });
}
