import { registerApiRoute } from '@mastra/core/server';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { existsSync } from 'node:fs';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.webp': 'image/webp',
};

/**
 * Returns API routes that serve the built web app when WEB_DIST_PATH is set.
 * In production the Dockerfile copies `apps/web/dist` to $WEB_DIST_PATH and
 * the Mastra server serves both API and UI on a single port.
 */
export function getWebStaticRoutes() {
  const distPath = process.env.WEB_DIST_PATH?.trim();
  if (!distPath) return [];

  return [
    registerApiRoute('/*', {
      method: 'GET',
      handler: async (c) => {
        const urlPath = new URL(c.req.url).pathname;

        // Guard against path traversal
        const relative = normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
        const filePath = join(distPath, relative);

        if (existsSync(filePath) && !filePath.endsWith('/')) {
          const content = await readFile(filePath);
          const mime = MIME[extname(filePath)] ?? 'application/octet-stream';
          return new Response(content, { headers: { 'Content-Type': mime, 'Cache-Control': 'public, max-age=31536000, immutable' } });
        }

        // SPA fallback — serve index.html for any unmatched path
        const indexPath = join(distPath, 'index.html');
        if (existsSync(indexPath)) {
          const content = await readFile(indexPath);
          return new Response(content, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' } });
        }

        return new Response('Not Found', { status: 404 });
      },
    }),
  ];
}
