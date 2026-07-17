# Macaron Artifacts site

The public docs + landing site, built with [Fumadocs](https://fumadocs.dev) on React Router (SPA / static export). Content lives in `content/docs/*.mdx`.

This is a standalone package: it is intentionally **not** part of the root pnpm workspace, so its Vite / React Router / Tailwind stack stays isolated from the web app. Install and run it on its own.

```bash
pnpm install          # from this directory
pnpm dev              # dev server
pnpm build            # static export → build/client
pnpm start            # preview the built site
```

Edit a page by adding or changing an `.mdx` file under `content/docs`; `meta.json` controls sidebar order.
