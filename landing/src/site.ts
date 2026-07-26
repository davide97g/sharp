/**
 * Single source of truth for the facts that appear in more than one place:
 * the page, the JSON-LD, robots.txt and sitemap.xml. Change them here.
 *
 * The canonical origin is NOT here on purpose — it comes from `site` in
 * astro.config.mjs (`Astro.site`), so a fork only edits one file.
 */
export const GITHUB_OWNER = "davide97g";
export const repo = `https://github.com/${GITHUB_OWNER}/sharp`;
export const releases = `${repo}/releases/latest`;
export const docsUrl = `${repo}/tree/main/docs`;

/** Version + freshness — AI answer engines weight dated, versioned content. */
export const version = "0.3.0";
export const updated = "2026-07-26";
export const updatedLabel = "July 26, 2026";

/** Trailing-slash-free origin, e.g. https://sharp.davideghiotto.it */
export const origin = (site: URL | undefined) =>
  (site?.href ?? "https://sharp.davideghiotto.it").replace(/\/$/, "");
