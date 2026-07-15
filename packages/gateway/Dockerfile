FROM node:26-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
RUN npm ci
# Build the whole gateway workspace closure (engine -> agent/commercial -> gateway).
RUN npm run build

FROM node:26-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
# Runtime workspace closure of @octopus-reef/gateway. engine is required by agent
# (its node_modules symlink resolves here); omitting it dangles the symlink at runtime.
COPY --from=build /app/packages/engine ./packages/engine
COPY --from=build /app/packages/gateway ./packages/gateway
COPY --from=build /app/packages/agent ./packages/agent
COPY --from=build /app/packages/commercial ./packages/commercial
EXPOSE 8787
CMD ["node", "packages/gateway/dist/bin.js"]
