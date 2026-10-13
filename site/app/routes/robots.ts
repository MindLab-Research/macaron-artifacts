import { siteUrl } from '@/lib/shared';

export function loader() {
  return new Response(`User-agent: *\nAllow: /\nDisallow: /app\nDisallow: /connect\n\nSitemap: ${siteUrl}/sitemap.xml\n`);
}
