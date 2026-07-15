# Reef — one-image governed workspace.
#
# M0: builds the monorepo and exposes the `reef` CLI as the entrypoint, so
#   docker run octopus-reef run "add rate limiting" --out /work/.reef/demo
# works out of the box, fully offline and keyless (mock driver).
#
# Later milestones add the server + web on top of this same image (M5).

# ---- build stage ----
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/engine/package.json packages/engine/package.json
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/driver-claude/package.json packages/driver-claude/package.json
COPY packages/agent/package.json packages/agent/package.json
COPY packages/adapter-runtime/package.json packages/adapter-runtime/package.json
COPY packages/adapter-observe/package.json packages/adapter-observe/package.json
COPY packages/adapter-blackboard/package.json packages/adapter-blackboard/package.json
COPY packages/adapter-experience/package.json packages/adapter-experience/package.json
COPY packages/adapter-scout/package.json packages/adapter-scout/package.json
COPY packages/commercial/package.json packages/commercial/package.json
COPY packages/gateway/package.json packages/gateway/package.json
COPY packages/server/package.json packages/server/package.json
COPY packages/cli/package.json packages/cli/package.json
COPY packages/web/package.json packages/web/package.json
COPY packages/ide/package.json packages/ide/package.json
RUN npm ci --no-audit --no-fund
COPY tsconfig.base.json ./
COPY packages ./packages
RUN npm run build

# ---- runtime stage ----
FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /work
COPY --from=build /app /app
# A writable session directory the demo can persist to.
RUN mkdir -p /work/.reef && ln -s /app/packages/cli/dist/cli.js /usr/local/bin/reef && chmod +x /app/packages/cli/dist/cli.js
ENTRYPOINT ["node", "/app/packages/cli/dist/cli.js"]
CMD ["run", "hello from a governed session", "--out", "/work/.reef/demo"]
