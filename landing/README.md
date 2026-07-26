# sharp landing

Astro single-page static site for [sharp](https://github.com/davide97g/sharp).
Dark, minimal, zero client JS beyond an OS-detect snippet (download button), the
copy-to-clipboard button and scroll reveals. Deployable to any static host and also
served by the VPS Caddy at the apex domain (see `deploy/`).

## Develop

```bash
bun install
bun run dev      # http://localhost:4321
bun run build    # → dist/  (static)
bun run preview
```

## Where the content lives

- `src/site.ts` — the facts shared by the page, the JSON-LD, `robots.txt` and
  `sitemap.xml`: repo owner, version, last-updated date. **Bump `version` and
  `updated` when you ship** — freshness and version signals are weighted by both
  search and AI answer engines.
- `src/pages/index.astro` — the whole page. Two arrays drive most of it:
  - `features` → the feature grid **and** the `schema.org` `featureList`
  - `faqs` → the visible `<details>` list **and** the `FAQPage` JSON-LD.
    Google requires each schema answer to match the visible text verbatim; keeping
    one array is what guarantees that, so never hand-write either side.
- `src/styles/global.css` — all styles, including a `prefers-reduced-motion` block
  that disables the orbs, particles and reveals.
- `astro.config.mjs` — `site` is the canonical origin. It feeds `Astro.site`, so the
  canonical link, OG URLs, `robots.txt` and `sitemap.xml` all follow it. That is the
  only place the domain is written in code.

## SEO / GEO assets

| File | Purpose |
| --- | --- |
| `src/pages/robots.txt.ts` | Allows search crawlers **and** AI answer engines (GPTBot, ClaudeBot, PerplexityBot, Google-Extended, …). A blocked AI bot cannot cite you. |
| `src/pages/sitemap.xml.ts` | One URL, real `lastmod` from `src/site.ts`. |
| `public/llms.txt` | [llmstxt.org](https://llmstxt.org) context file: what sharp is, hard numbers, links into the docs. |
| `public/llms-full.txt` | The whole page as plain markdown, for assistants that would rather read text than render a page. |
| `public/pricing.md` | Machine-readable pricing — agents comparing products skip what they cannot parse. |
| `public/og.png` | 1200×630 social card, generated from `mock/og.html` (see below). |

In the page itself: a JSON-LD `@graph` with `WebSite`, `Person`, `SoftwareApplication`
(free offer + featureList), `HowTo` (self-host in three steps) and `FAQPage`; a 40–60
word definition block under "What is sharp?"; plus a spec table, a comparison table and
twelve FAQ answers — the extractable shapes AI engines quote. Inter is self-hosted via
`@fontsource-variable/inter`, so no third-party font request sits in the critical path.

The three text files under `public/` are hand-written and repeat the domain and repo
URLs — update them when either changes.

### Regenerate the OG image

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless --disable-gpu --hide-scrollbars --window-size=1200,630 \
  --screenshot=public/og.png "file://$PWD/mock/og.html"
```

`mock/thumbnail.html` is the separate, larger app-shot mock (1600×1000) used for
README and social art.

## Before deploying

- `GITHUB_OWNER` in `src/site.ts` is set to `davide97g`. It drives the repo link, the
  `git clone` snippet, the license link and every `releases/latest` download link —
  change it if you fork under a different org/user.
- Set `site` in `astro.config.mjs` to your production apex domain, then update the URLs
  inside `public/llms.txt`, `public/llms-full.txt` and `public/pricing.md` to match.
- Submit `https://<your-domain>/sitemap.xml` in Google Search Console and Bing Webmaster
  Tools, and validate the structured data with the
  [Rich Results Test](https://search.google.com/test/rich-results).

## Output

`bun run build` emits fully static HTML/CSS to `dist/`. The `deploy/` Caddy config
mounts `../landing/dist` at `/srv/landing` and serves it on the apex domain.
