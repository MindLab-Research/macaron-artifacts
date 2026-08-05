// Canonical provider endpoint = the Anthropic *base* URL, WITHOUT `/v1` —
// same contract as ANTHROPIC_BASE_URL, where the SDK appends `/v1/messages`.
// Users paste both forms (env snippets ship the bare host, docs pages often
// show `.../v1`), so we strip a trailing `/v1` on the way in and add it back
// when building a request URL. Without this, a bare host hits `/messages`,
// which on an SPA-fronted gateway returns the index.html with HTTP 200 and
// the CLI reports "empty or malformed response".
export function normalizeAnthropicBase(endpoint: string): string {
  return endpoint.trim().replace(/\/+$/, '').replace(/\/v1$/, '');
}

export function anthropicMessagesUrl(endpoint: string): string {
  return `${normalizeAnthropicBase(endpoint)}/v1/messages`;
}
