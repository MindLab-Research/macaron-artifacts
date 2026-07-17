import { createFromSource } from 'fumadocs-core/search/server';
import { buildIndex } from '@/lib/search-index';
import { source } from '@/lib/source';

// buildIndex strips the markdown/HTML-entity noise (`, **, [text](url), &#x60;…)
// that structuredData otherwise leaks into search result summaries.
const server = createFromSource(source, {
  language: 'english',
  buildIndex,
});

export async function loader() {
  return server.staticGET();
}
