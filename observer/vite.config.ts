import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const here = fileURLToPath(new URL(".", import.meta.url));
const devServerPort = Number(process.env.PRIME_OBSERVER_PORT ?? 8790);

export default defineConfig({
	root: `${here}src/web`,
	plugins: [react()],
	build: {
		outDir: `${here}dist/web`,
		emptyOutDir: true,
		sourcemap: false,
	},
	server: {
		port: 5173,
		proxy: {
			"/api": { target: `http://127.0.0.1:${devServerPort}`, changeOrigin: false },
			"/ws": { target: `ws://127.0.0.1:${devServerPort}`, ws: true },
		},
	},
});
