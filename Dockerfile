# ── ASO Audit Agent ─────────────────────────────────────────────────────────
# One image that runs the whole app — the Mastra server and the web UI — via
# `npm run dev`. docker-compose builds and starts it; see docker-compose.yml.

FROM node:22-slim

WORKDIR /app

# Install dependencies first. Copying only the manifests keeps this layer
# cached until a package.json or the lockfile actually changes.
COPY package.json package-lock.json ./
COPY apps/server/package.json ./apps/server/package.json
COPY apps/web/package.json ./apps/web/package.json
RUN npm ci --no-audit --no-fund

# Application source (node_modules, .env, build caches excluded — see
# .dockerignore — so dependencies are always installed fresh for Linux).
COPY tsconfig.base.json ./
COPY apps ./apps

# 5173 = web UI (this is the one to open) · 4111 = Mastra server + Studio.
EXPOSE 5173 4111

CMD ["npm", "run", "dev"]
