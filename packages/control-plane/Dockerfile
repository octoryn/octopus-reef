# Build with the repository root as context:
# docker build -f packages/control-plane/Dockerfile .
FROM node:22.17.1-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/engine/package.json packages/engine/
COPY packages/protocol/package.json packages/protocol/
COPY packages/driver-claude/package.json packages/driver-claude/
COPY packages/agent/package.json packages/agent/
COPY packages/adapter-runtime/package.json packages/adapter-runtime/
COPY packages/adapter-observe/package.json packages/adapter-observe/
COPY packages/adapter-blackboard/package.json packages/adapter-blackboard/
COPY packages/adapter-experience/package.json packages/adapter-experience/
COPY packages/adapter-scout/package.json packages/adapter-scout/
COPY packages/control-plane/package.json packages/control-plane/
COPY packages/commercial/package.json packages/commercial/
COPY packages/gateway/package.json packages/gateway/
COPY packages/server/package.json packages/server/
COPY packages/cli/package.json packages/cli/
COPY packages/web/package.json packages/web/
COPY packages/ide/package.json packages/ide/
RUN npm ci

COPY packages/engine/tsconfig.json packages/engine/tsconfig.json
COPY packages/engine/src packages/engine/src
COPY packages/protocol/tsconfig.json packages/protocol/tsconfig.json
COPY packages/protocol/src packages/protocol/src
COPY packages/agent/tsconfig.json packages/agent/tsconfig.json
COPY packages/agent/src packages/agent/src
COPY packages/adapter-runtime/tsconfig.json packages/adapter-runtime/tsconfig.json
COPY packages/adapter-runtime/src packages/adapter-runtime/src
COPY packages/control-plane/tsconfig.json packages/control-plane/tsconfig.json
COPY packages/control-plane/src packages/control-plane/src
COPY packages/control-plane/migrations packages/control-plane/migrations
COPY packages/control-plane/README.md packages/control-plane/README.md
RUN npx tsc -b packages/engine packages/protocol packages/agent packages/adapter-runtime packages/control-plane
RUN npm prune --omit=dev

FROM node:22.17.1-bookworm-slim AS runtime-base
WORKDIR /app
ENV NODE_ENV=production \
    REEF_CONTROL_PLANE_HOST=0.0.0.0 \
    REEF_CONTROL_PLANE_PORT=8080

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git \
    && apt-get clean \
    && find /var/lib/apt/lists -mindepth 1 -delete

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages/engine/package.json ./packages/engine/package.json
COPY --from=build /app/packages/engine/dist ./packages/engine/dist
COPY --from=build /app/packages/protocol/package.json ./packages/protocol/package.json
COPY --from=build /app/packages/protocol/dist ./packages/protocol/dist
COPY --from=build /app/packages/agent/package.json ./packages/agent/package.json
COPY --from=build /app/packages/agent/dist ./packages/agent/dist
COPY --from=build /app/packages/adapter-runtime/package.json ./packages/adapter-runtime/package.json
COPY --from=build /app/packages/adapter-runtime/dist ./packages/adapter-runtime/dist
COPY --from=build /app/packages/control-plane/package.json ./packages/control-plane/package.json
COPY --from=build /app/packages/control-plane/dist ./packages/control-plane/dist
COPY --from=build /app/packages/control-plane/migrations ./packages/control-plane/migrations
COPY --from=build /app/packages/control-plane/README.md ./packages/control-plane/README.md

USER node
ENTRYPOINT ["node", "/app/packages/control-plane/dist/bin.js"]

FROM runtime-base AS api
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.REEF_CONTROL_PLANE_PORT||8080)+'/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["api"]

FROM runtime-base AS worker
HEALTHCHECK NONE
CMD ["worker"]
