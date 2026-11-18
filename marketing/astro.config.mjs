// @ts-check
import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
	site: 'https://odinpmp.com',
	devToolbar: { enabled: false },
	vite: {
		// three.js is one ~540 kB chunk, loaded only after the hero renders.
		build: { chunkSizeWarningLimit: 600 },
	},
});
