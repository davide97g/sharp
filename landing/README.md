# sharp landing

Astro (v5) single-page static site for [sharp](https://github.com/davide97g/sharp).
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

- `GITHUB_OWNER` in `src/pages/index.astro` is set to `davide97g`. It drives the repo
  link, the `git clone` snippet, the license link and all `releases/latest` download
  links — change it if you fork under a different org/user.
- Set `site` in `astro.config.mjs` to your production apex domain so canonical and
  Open Graph URLs are correct.

## Output

`bun run build` emits fully static HTML/CSS to `dist/`. The `deploy/` Caddy config
mounts `../landing/dist` at `/srv/landing` and serves it on the apex domain.
