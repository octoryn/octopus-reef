# Reef — one-command governed workspace.
#
#   docker build -t octopus-reef .
#   docker run --rm -p 4300:4300 octopus-reef
#   → open http://localhost:4300  (governed backend + web UI, offline & keyless)
#
# Multi-stage: build the libraries + the web bundle, then ship a slim runtime
# that serves the API and the built UI from one process.

# ---- build stage ----------------------------------------------------------
FROM node:22-slim AS build
WORKDIR /app

# Install with the full workspace lockfile for reproducible builds.
# Every workspace's manifest must be present for `npm ci` to resolve the tree.
COPY package.json package-lock.json ./
COPY packages/engine/package.json packages/engine/
COPY packages/protocol/package.json packages/protocol/
COPY packages/driver-claude/package.json packages/driver-claude/
COPY packages/adapter-runtime/package.json packages/adapter-runtime/
COPY packages/adapter-observe/package.json packages/adapter-observe/
COPY packages/adapter-blackboard/package.json packages/adapter-blackboard/
COPY packages/adapter-experience/package.json packages/adapter-experience/
COPY packages/adapter-scout/package.json packages/adapter-scout/
COPY packages/server/package.json packages/server/
COPY packages/cli/package.json packages/cli/
COPY packages/web/package.json packages/web/
COPY packages/ide/package.json packages/ide/
RUN npm ci

COPY . .
# Build the Node libraries (tsc project refs) and the web bundle (Vite).
RUN npm run build && npm run build:web

# Prune dev dependencies for the runtime image.
RUN npm prune --omit=dev

# ---- runtime stage --------------------------------------------------------
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4300 \
    REEF_STATIC=/app/packages/web/dist

# Runtime deps + compiled output only.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages/engine/package.json ./packages/engine/package.json
COPY --from=build /app/packages/engine/dist ./packages/engine/dist
COPY --from=build /app/packages/protocol/package.json ./packages/protocol/package.json
COPY --from=build /app/packages/protocol/dist ./packages/protocol/dist
COPY --from=build /app/packages/server/package.json ./packages/server/package.json
COPY --from=build /app/packages/server/dist ./packages/server/dist
COPY --from=build /app/packages/web/dist ./packages/web/dist

# Run as the unprivileged node user (defense in depth — this is a governed tool).
USER node
EXPOSE 4300
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4300)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "packages/server/dist/bin.js"]
