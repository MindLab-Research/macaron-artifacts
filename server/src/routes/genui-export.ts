import type { FastifyInstance } from 'fastify';

// Building a fully self-contained HTML export means running the same Vite +
// UnoCSS pipeline the official artifacts site uses to render GenUI — a heavy
// dependency the shipped server bundle deliberately doesn't carry. So we proxy
// the official builder (same code path the reference macaron-genui-demo export
// uses), which SSRs the widget and inlines the display-time importmap shims +
// UnoCSS CSS into one standalone file. The endpoint has no CORS, hence this
// same-origin server hop rather than a direct browser fetch.
const EXPORT_ENDPOINT = process.env.MACARON_GENUI_EXPORT_ENDPOINT || 'https://genui.macaron.im/api/genui-html';

type ExportBody = { code?: string };

export async function registerGenuiExportRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: ExportBody }>('/api/genui/export-html', async (req, reply) => {
    const code = String(req.body?.code || '').trim();
    if (!code) return reply.status(400).send({ error: 'code required' });
    let upstream: Response;
    try {
      upstream = await fetch(EXPORT_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, ssr: true }),
      });
    } catch (e) {
      return reply.status(502).send({ error: `export builder unreachable: ${(e as Error).message}` });
    }
    if (!upstream.ok) return reply.status(502).send({ error: `export builder failed (${upstream.status})` });
    const html = await upstream.text();
    return reply
      .header('content-type', 'text/html; charset=utf-8')
      .header('content-disposition', 'attachment; filename="macaron-genui.html"')
      .send(html);
  });
}
