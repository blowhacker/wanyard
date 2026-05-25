# wanyard.com

The marketing site. Three files, no build step.

```
site/
├── index.html      ← copy lives here
├── style.css       ← visuals live here
└── assets/
    └── feed.jpg    ← swap for a better screenshot when you have one
```

## Deploy

**Cloudflare Pages** (recommended — free, instant cache invalidation, custom domain in one click):

1. Push the wanyard repo to GitHub.
2. Cloudflare → Pages → Connect to Git → pick the repo.
3. Build settings:
   - Framework preset: **None**
   - Build command: *(leave empty)*
   - Build output directory: `site`
4. Add `wanyard.com` as a custom domain.

**GitHub Pages** (alternative — also free, slightly slower to update):

Settings → Pages → Source: `main` / folder: `/site`.

Both rebuild on every push to `main`.

## Edit

Need to change a paragraph? Open `index.html`, find it, save, push. There is no framework. There is no bundler. There is no `node_modules`.

Need to tweak the dark/amber palette? Open `style.css`, change the variables at the top of `:root`. Done.

Need to swap the accent colour permanently? Set `data-accent="green"` (or `blue`, `red`) on `<html>` — the alt-palettes are already defined.

## What's intentionally NOT here

- No analytics. Add Plausible / Umami / Fathom yourself if you want.
- No SEO bloat. Add `<meta>` tags for OG image / description when you have them.
- No favicon yet. Drop a `favicon.ico` in `site/` and link it.
- No service worker, no PWA. It's a one-page site.
