// @ts-check
import { defineConfig } from 'astro/config';

// Static single-page landing site for sharp.
// Deployable to any static host; served on Dokploy as its own service.
export default defineConfig({
  output: 'static',
  // Production apex domain — used for canonical/OG URLs.
  site: 'https://sharp.davideghiotto.it',
});
