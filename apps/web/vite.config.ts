import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Where the Mastra server lives. Same-origin localhost for `npm run dev`;
// overridable for other topologies. (The Docker image runs both processes in
// one container, so localhost still applies there.)
const proxyTarget =
  process.env.MASTRA_PROXY_TARGET ??
  `http://localhost:${process.env.PORT ?? '4111'}`;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // Bind all interfaces so the dev server is reachable from outside a
    // container; harmless for local use.
    host: true,
    // Proxy the audit API to the Mastra server — the browser stays
    // same-origin, so no CORS and no backend URL baked into the client.
    proxy: {
      '/audit': {
        target: proxyTarget,
        changeOrigin: true,
      },
      '/auth': {
        target: proxyTarget,
        changeOrigin: true,
      },
    },
  },
});
