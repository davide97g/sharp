import type { APIRoute } from "astro";
import { origin, updated } from "../site";

/** One page, one URL — but a real sitemap with a real lastmod. */
export const GET: APIRoute = ({ site }) => {
  const base = origin(site);
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${base}/</loc>
    <lastmod>${updated}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
  </url>
</urlset>
`;

  return new Response(body, {
    headers: { "Content-Type": "application/xml; charset=utf-8" },
  });
};
