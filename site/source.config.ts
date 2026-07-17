import { defineConfig, defineDocs } from 'fumadocs-mdx/config';
import { resolveCommitSha } from './app/lib/commit-sha';

// Replace the `<sha>` placeholder in fenced install commands with the build commit's short
// SHA, so the rendered commands pin to whatever commit produced the docs. Runs at build time.
function remarkCommitSha() {
  const sha = resolveCommitSha();
  if (sha === '<sha>') return () => {};
  const walk = (node: any) => {
    // Only rewrite fenced code blocks (the commands) — leave prose `<sha>` mentions intact.
    if (node?.type === 'code' && typeof node.value === 'string') node.value = node.value.replaceAll('<sha>', sha);
    if (Array.isArray(node?.children)) node.children.forEach(walk);
  };
  return walk;
}

export const docs = defineDocs({
  dir: 'content/docs',
  docs: {
    postprocess: {
      includeProcessedMarkdown: true,
    },
  },
});

export default defineConfig({
  mdxOptions: {
    remarkPlugins: [remarkCommitSha],
  },
});
