// One-shot connectivity probe for a provider's endpoint/model/key, run from
// the Settings form before the user commits the row. Deliberately minimal:
// a non-streaming 1-token completion is the cheapest call that exercises the
// full path (DNS → TLS → auth → model routing) end to end.
//
// The failure we most want to name is the silent one: an SPA-fronted gateway
// answers an unknown path with its index.html and HTTP 200, so the CLI later
// reports a useless "empty or malformed response". Sniffing the body for HTML
// turns that into "this looks like a web page, check the endpoint".

import { anthropicMessagesUrl } from './anthropic-endpoint.js';

export type ProviderProbe = {
  ok: boolean;
  url: string;
  status?: number;
  latencyMs: number;
  detail?: string;
};

const TIMEOUT_MS = 20_000;

export async function probeProvider(input: {
  endpoint: string;
  model: string;
  apiKey: string;
}): Promise<ProviderProbe> {
  const url = anthropicMessagesUrl(input.endpoint);
  const started = Date.now();
  const done = (r: Omit<ProviderProbe, 'url' | 'latencyMs'>): ProviderProbe => ({
    ...r,
    url,
    latencyMs: Date.now() - started,
  });

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${input.apiKey}`,
        'x-api-key': input.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: input.model,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }],
      }),
    });
  } catch (e) {
    const err = e as Error;
    const timedOut = err.name === 'TimeoutError' || err.name === 'AbortError';
    return done({
      ok: false,
      detail: timedOut ? `no response within ${TIMEOUT_MS / 1000}s` : `could not reach the endpoint — ${err.message}`,
    });
  }

  const text = await res.text().catch(() => '');
  if (!res.ok) {
    const hint = res.status === 401 || res.status === 403 ? 'API key rejected' : res.status === 404 ? 'endpoint not found' : `HTTP ${res.status}`;
    return done({ ok: false, status: res.status, detail: `${hint} — ${firstLine(text)}` });
  }
  if (/^\s*</.test(text)) {
    return done({
      ok: false,
      status: res.status,
      detail: 'the endpoint answered with a web page, not an API response — check the URL',
    });
  }
  let json: { type?: string; model?: string; error?: { message?: string } } | null = null;
  try {
    json = JSON.parse(text);
  } catch {
    return done({ ok: false, status: res.status, detail: `unreadable response — ${firstLine(text)}` });
  }
  if (json?.type === 'error') {
    return done({ ok: false, status: res.status, detail: json.error?.message || 'provider returned an error' });
  }
  if (json?.type !== 'message') {
    return done({ ok: false, status: res.status, detail: `unexpected response shape — ${firstLine(text)}` });
  }
  return done({ ok: true, status: res.status, detail: `replied as ${json.model || input.model}` });
}

function firstLine(body: string): string {
  return body.replace(/\s+/g, ' ').trim().slice(0, 200) || '(empty body)';
}
