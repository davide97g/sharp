import type { APIRoute } from "astro";
import { origin } from "../site";

/**
 * robots.txt as an endpoint so the Sitemap line always matches `site` in
 * astro.config.mjs.
 *
 * Everything here is public documentation for an open-source project, so both
 * search crawlers and AI answer engines are allowed: a blocked GPTBot /
 * ClaudeBot / PerplexityBot means those engines literally cannot cite you.
 */
const AI_AND_SEARCH_AGENTS = [
  // Search
  "Googlebot",
  "Bingbot",
  "DuckDuckBot",
  "Applebot",
  // AI answer engines (search-and-cite)
  "Google-Extended",
  "GPTBot",
  "ChatGPT-User",
  "OAI-SearchBot",
  "ClaudeBot",
  "Claude-User",
  "Claude-SearchBot",
  "anthropic-ai",
  "PerplexityBot",
  "Perplexity-User",
  "Applebot-Extended",
  "Amazonbot",
  "meta-externalagent",
  "cohere-ai",
];

export const GET: APIRoute = ({ site }) => {
  const base = origin(site);
  const body = [
    `# sharp — ${base}`,
    "# Public docs for an open-source project: crawl it, index it, cite it.",
    "",
    "User-agent: *",
    "Allow: /",
    "",
    ...AI_AND_SEARCH_AGENTS.flatMap((ua) => [`User-agent: ${ua}`, "Allow: /", ""]),
    `Sitemap: ${base}/sitemap.xml`,
    "",
  ].join("\n");

  return new Response(body, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
};
