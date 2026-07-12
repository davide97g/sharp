# sharp landing

Astro (v5) single-page static site for [sharp](https://github.com/GITHUB_OWNER/sharp).
Dark, minimal, zero client JS beyond an OS-detect snippet (download button) and the
copy-to-clipboard button. Deployable to any static host and also served by the VPS
Caddy at the apex domain (see `deploy/`).

## Develop

```bash
bun install
bun run dev      # http://localhost:4321
bun run build    # → dist/  (static)
bun run preview
```

## Before deploying

- Replace the literal `GITHUB_OWNER` placeholder in `src/pages/index.astro` with your
  GitHub org/user. It is used for the repo link, the `git clone` snippet, the license
  link and all `releases/latest` download links.
- Set `site` in `astro.config.mjs` to your production apex domain so canonical and
  Open Graph URLs are correct.

## Output

`bun run build` emits fully static HTML/CSS to `dist/`. The `deploy/` Caddy config
mounts `../landing/dist` at `/srv/landing` and serves it on the apex domain.
