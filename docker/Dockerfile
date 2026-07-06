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
COPY package.json package-lock.json* ./
COPY packages/engine/package.json packages/engine/package.json
COPY packages/cli/package.json packages/cli/package.json
RUN npm install --no-audit --no-fund
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
