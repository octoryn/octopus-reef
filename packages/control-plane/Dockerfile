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
    && apt-get install -y --no-install-recommends ca-certificates curl git \
    && curl --fail --silent --show-error --location \
      https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
      --output /etc/ssl/certs/aws-rds-global-bundle.pem \
    && echo "e5bb2084ccf45087bda1c9bffdea0eb15ee67f0b91646106e466714f9de3c7e3  /etc/ssl/certs/aws-rds-global-bundle.pem" | sha256sum --check --strict \
    && chmod 0444 /etc/ssl/certs/aws-rds-global-bundle.pem \
    && mkdir -p /workspace \
    && chown node:node /workspace \
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

FROM runtime-base AS sandbox
# The sandbox self-materialises its workspace from the Builder source binding
# (`REEF_SOURCE_BINDING`) by cloning an IAM-authenticated CodeCommit repo, then
# runs the generated Next.js + FastAPI project's install/test commands with NO
# network egress. It therefore ships a fully offline toolchain closure, mirroring
# the proven verification golden sandbox (python3 + /opt/wheels + seeded npm
# cache):
#   * awscli   — `aws codecommit credential-helper` for the IAM-authenticated
#     CodeCommit clone (credentials resolve from the sandbox task role only).
#   * Python 3.12 (python-build-standalone; self-contained/relocatable) — the
#     generated backend pins `requires-python>=3.12` and installs editable via
#     `pip install -e ".[dev]"`, so bookworm's 3.11 is insufficient.
#   * /opt/wheels — the flattened backend dependency closure plus build backends
#     (pip/setuptools/wheel), consumed offline via
#     `pip install --no-index --find-links=/opt/wheels` (PIP_NO_INDEX default).
#   * /opt/npm-cache — the golden-path frontend tarball closure, consumed offline
#     via `npm install` (npm_config_offline default).
# All fetches happen at build time; the runtime stays no-egress except the
# CodeCommit clone endpoint. Stays non-root (node); only the /workspace and /tmp
# volumes are writable at runtime.
USER root

# awscli for the CodeCommit credential helper; xz-utils to unpack the Python
# standalone archive.
RUN apt-get update \
    && apt-get install -y --no-install-recommends awscli xz-utils \
    && apt-get clean \
    && find /var/lib/apt/lists -mindepth 1 -delete

# --- Python 3.12 (self-contained, relocatable; checksum-pinned) --------------
# python-build-standalone locates its stdlib relative to the interpreter's own
# bin/ directory; invoking it through an external symlink (e.g. under
# /usr/local/bin) breaks `venv` home resolution (the derived interpreter falls
# back to the build-time `/install` prefix and cannot import `encodings`).
# Prepend its own bin/ to PATH instead — `python`/`python3` then resolve inside
# /opt/python/bin and venvs inherit the correct base prefix.
ENV PATH="/opt/python/bin:${PATH}"
ARG PY_STANDALONE_URL="https://github.com/astral-sh/python-build-standalone/releases/download/20241219/cpython-3.12.8+20241219-x86_64-unknown-linux-gnu-install_only.tar.gz"
ARG PY_STANDALONE_SHA256="e172c063cdad4ab016f78834b1ef9fedfac80aae08918188fe6ebb3b325ce347"
RUN curl --fail --silent --show-error --location "${PY_STANDALONE_URL}" \
      --output /tmp/python-standalone.tar.gz \
    && echo "${PY_STANDALONE_SHA256}  /tmp/python-standalone.tar.gz" \
      | sha256sum --check --strict \
    && tar -xzf /tmp/python-standalone.tar.gz -C /opt \
    && rm /tmp/python-standalone.tar.gz \
    && test "$(python3 --version)" = "Python 3.12.8" \
    && python3 -m venv /tmp/venv-probe \
    && /tmp/venv-probe/bin/python -c "import encodings, ssl, sqlite3, ctypes" \
    && rm -rf /tmp/venv-probe

# --- Backend offline wheelhouse (/opt/wheels) --------------------------------
# The generated backend/requirements.txt is a deterministic flattened closure;
# pip download resolves the full transitive tree as linux/amd64 manylinux wheels
# (this stage builds under linux/amd64). pip/setuptools/wheel are added so the
# editable `pip install -e .` build isolation resolves its backend offline too.
COPY packages/control-plane/sandbox-seed/backend-requirements.txt \
     /opt/sandbox-seed/backend-requirements.txt
RUN python3 -m pip install --no-cache-dir --upgrade pip setuptools wheel \
    && python3 -m pip download --no-cache-dir --dest /opt/wheels \
         --requirement /opt/sandbox-seed/backend-requirements.txt \
    && python3 -m pip download --no-cache-dir --dest /opt/wheels \
         pip setuptools wheel \
    && chmod -R a+rX /opt/wheels /opt/python

# --- Frontend offline npm cache (/opt/npm-cache) -----------------------------
# Seed the content-addressed cache with the golden-path frontend tarball closure
# from the generated lockfile; `npm ci --ignore-scripts` populates the cache, and
# node_modules is discarded (only the cache is retained for offline installs).
ENV npm_config_cache=/opt/npm-cache
COPY packages/control-plane/sandbox-seed/frontend/package.json \
     packages/control-plane/sandbox-seed/frontend/package-lock.json \
     /opt/sandbox-seed/frontend/
RUN cd /opt/sandbox-seed/frontend \
    && npm ci --ignore-scripts \
    && rm -rf node_modules \
    && npm cache verify \
    && chmod -R a+rX /opt/npm-cache

# --- Offline resolution defaults (no-egress runtime) -------------------------
ENV PIP_NO_INDEX=1 \
    PIP_FIND_LINKS=/opt/wheels \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    npm_config_cache=/opt/npm-cache \
    npm_config_offline=true \
    npm_config_audit=false \
    npm_config_fund=false \
    NEXT_TELEMETRY_DISABLED=1

USER node
ENV REEF_SANDBOX_HOST=0.0.0.0 \
    REEF_SANDBOX_PORT=8081 \
    REEF_SANDBOX_WORKSPACE=/workspace
EXPOSE 8081
ENTRYPOINT ["node", "/app/packages/control-plane/dist/sandbox-runner.js"]
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.REEF_SANDBOX_PORT||8081)+'/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
