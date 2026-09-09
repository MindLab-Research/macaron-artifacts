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

## Styles

All locally authored utility classes use UnoCSS `presetWind4`, prefixed with the `site:` variant so they cannot override Fumadocs' internal responsive utilities. `uno.config.ts` owns these classes and the semantic `fd-*` colors. Wind4 supplies the only global reset.

Fumadocs' official precompiled `style.css` supplies its dependency-owned components, prose, search, and sidebar styles. The Vite compatibility plugin removes that stylesheet's duplicate reset with PostCSS; it does not compile Tailwind or scan local source. A test guards the vendor reset boundary. Per-module UnoCSS output supports React Router's client and prerender environments, with explicit cascade layer ordering in every CSS chunk.

The navigation palette menu maps bundled Shiki themes to `--color-fd-*` variables and matching code-token themes. Neutral preserves the original Fumadocs colors. Theme preferences stay in browser storage and never enter model prompts.
