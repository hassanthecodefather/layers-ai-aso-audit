# ── ASO Audit Agent — production image ──────────────────────────────────────
#
# Multi-stage build:
#   deps    — install all dependencies (cached until package-lock.json changes)
#   build   — compile web UI (Vite) + server bundle (mastra build)
#   runtime — lean Node image with only the built artifacts
#
# The Mastra server serves both the API (port 4111) and the React web app.
# Set WEB_DIST_PATH=/app/web-dist in the runtime stage (done below).

# ── Stage 1: install dependencies ────────────────────────────────────────────
FROM node:22-slim AS deps
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/server/package.json ./apps/server/package.json
COPY apps/web/package.json ./apps/web/package.json
RUN npm ci --no-audit --no-fund

# ── Stage 2: build ────────────────────────────────────────────────────────────
FROM deps AS build
WORKDIR /app

COPY tsconfig.base.json ./
COPY apps ./apps

# Build the React web app → apps/web/dist/
RUN cd apps/web && npm run build

# Build the Mastra server bundle → apps/server/.mastra/output/index.mjs
RUN cd apps/server && npx mastra build --dir src/mastra

# ── Stage 3: runtime ─────────────────────────────────────────────────────────
FROM node:22-slim AS runtime
WORKDIR /app

# Copy only what the server needs at runtime
COPY --from=build /app/apps/server/.mastra/output ./apps/server/.mastra/output
COPY --from=build /app/apps/web/dist ./web-dist

# Mastra bundles all server deps, but postgres.js uses a native addon on some
# platforms; copy node_modules as a safe fallback.
COPY --from=build /app/node_modules ./node_modules

ENV NODE_ENV=production
ENV WEB_DIST_PATH=/app/web-dist

# 4111 = Mastra server (API + web UI)
EXPOSE 4111

CMD ["node", "apps/server/.mastra/output/index.mjs"]
