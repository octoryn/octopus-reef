# Build from the repository root:
# docker build -f packages/verification/Dockerfile --target api .
# docker build -f packages/verification/Dockerfile --target worker .
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
COPY packages/verification/package.json packages/verification/
COPY packages/commercial/package.json packages/commercial/
COPY packages/gateway/package.json packages/gateway/
COPY packages/server/package.json packages/server/
COPY packages/cli/package.json packages/cli/
COPY packages/web/package.json packages/web/
COPY packages/ide/package.json packages/ide/
RUN npm ci --ignore-scripts

COPY packages/engine/tsconfig.json packages/engine/tsconfig.json
COPY packages/engine/src packages/engine/src
COPY packages/protocol/tsconfig.json packages/protocol/tsconfig.json
COPY packages/protocol/src packages/protocol/src
COPY packages/verification/tsconfig.json packages/verification/tsconfig.json
COPY packages/verification/src packages/verification/src
COPY packages/verification/migrations packages/verification/migrations
COPY packages/verification/README.md packages/verification/README.md
RUN npx tsc -b packages/engine packages/protocol packages/verification
RUN npm prune --omit=dev --ignore-scripts

FROM node:22.17.1-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    REEF_VERIFICATION_HOST=0.0.0.0 \
    REEF_VERIFICATION_PORT=8080

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && curl --fail --silent --show-error --location \
      https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
      --output /etc/ssl/certs/aws-rds-global-bundle.pem \
    && echo "e5bb2084ccf45087bda1c9bffdea0eb15ee67f0b91646106e466714f9de3c7e3  /etc/ssl/certs/aws-rds-global-bundle.pem" | sha256sum --check --strict \
    && chmod 0444 /etc/ssl/certs/aws-rds-global-bundle.pem \
    && apt-get clean \
    && find /var/lib/apt/lists -mindepth 1 -delete

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages/engine/package.json ./packages/engine/package.json
COPY --from=build /app/packages/engine/dist ./packages/engine/dist
COPY --from=build /app/packages/protocol/package.json ./packages/protocol/package.json
COPY --from=build /app/packages/protocol/dist ./packages/protocol/dist
COPY --from=build /app/packages/verification/package.json ./packages/verification/package.json
COPY --from=build /app/packages/verification/dist ./packages/verification/dist
COPY --from=build /app/packages/verification/migrations ./packages/verification/migrations
COPY --from=build /app/packages/verification/README.md ./packages/verification/README.md

USER node
ENTRYPOINT ["node", "/app/packages/verification/dist/bin.js"]

FROM runtime AS api
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.REEF_VERIFICATION_PORT||8080)+'/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["api"]

FROM runtime AS worker
HEALTHCHECK NONE
CMD ["worker"]
