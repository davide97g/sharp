// @ts-check
import { defineConfig } from 'astro/config';

// Static single-page landing site for sharp.
// Deployable to any static host; also served by the VPS Caddy at the apex domain.
export default defineConfig({
  output: 'static',
  // Set `site` to your production apex domain for correct canonical/OG URLs.
  site: 'https://example.com',
});
