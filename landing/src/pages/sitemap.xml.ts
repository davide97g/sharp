import type { APIRoute } from "astro";
import { legalUpdated, origin, updated } from "../site";

/**
 * Small site, real sitemap: the landing page plus the two legal pages, each with
 * its own `lastmod` — the policies move on their own cadence, so they must not
 * inherit the product's release date.
 */
const pages = [
  { path: "/", lastmod: updated, changefreq: "weekly", priority: "1.0" },
  { path: "/privacy", lastmod: legalUpdated, changefreq: "yearly", priority: "0.3" },
  { path: "/terms", lastmod: legalUpdated, changefreq: "yearly", priority: "0.3" },
];

export const GET: APIRoute = ({ site }) => {
  const base = origin(site);
  const urls = pages
    .map(
      ({ path, lastmod, changefreq, priority }) => `  <url>
    <loc>${base}${path}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>${changefreq}</changefreq>
    <priority>${priority}</priority>
  </url>`,
    )
    .join("\n");

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;

  return new Response(body, {
    headers: { "Content-Type": "application/xml; charset=utf-8" },
  });
};
