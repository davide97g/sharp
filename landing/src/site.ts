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

/**
 * Legal pages (`/privacy`, `/terms`) carry their own effective date: the policy
 * text changes on a different cadence from the product, so bumping `version`
 * above must NOT silently re-date a legal document.
 */
export const legalUpdated = "2026-07-27";
export const legalUpdatedLabel = "July 27, 2026";

/** The operator named in both legal documents, and how to reach them. */
export const operator = "Davide Ghiotto";
export const operatorSite = "https://davideghiotto.it";
export const privacyEmail = "privacy@sharp.davideghiotto.it";
export const legalEmail = "legal@sharp.davideghiotto.it";

/**
 * The one instance the operator runs. The legal pages cover this host and this
 * site only — every other deployment is somebody else's, and that distinction
 * is the whole point of the scope section in `/privacy`.
 */
export const appUrl = "https://app.sharp.davideghiotto.it";

/** Trailing-slash-free origin, e.g. https://sharp.davideghiotto.it */
export const origin = (site: URL | undefined) =>
  (site?.href ?? "https://sharp.davideghiotto.it").replace(/\/$/, "");
