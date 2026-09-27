# Prime Agent + observer web UI, for RunPod CPU pods (and local rehearsal via docker compose).
#
# Design (see deploy/README.md):
#   * The repo SOURCE is NOT baked in. entrypoint.sh clones/pulls erikcik/prime-agent-eray onto the
#     network volume (/workspace/app) so the observer's Refresh button can `git pull` + rebuild in place.
#   * The image bakes what is expensive or filesystem-sensitive: system deps, uv, a warmed npm cache,
#     and the Python kernel venv on container disk (RunPod volumes ignore chmod, which breaks venvs).
#   * Runs as uid 1000 (`node`), PID 1 = tini, root only for the ownership fix + sshd start.
#
# Build (from repo root, amd64 for pods):
#   docker buildx build --platform linux/amd64 -f deploy/Dockerfile -t ghcr.io/erikcik/prime-agent-eray:<tag> --push .

ARG NODE_IMAGE=node:22-bookworm-slim
ARG UV_IMAGE=ghcr.io/astral-sh/uv:0.9.7

FROM ${UV_IMAGE} AS uv

FROM ${NODE_IMAGE} AS runtime
ARG DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git openssh-client openssh-server rsync procps tini gosu xz-utils jq \
      python3 make g++ ripgrep fd-find \
      libcairo2 libpango-1.0-0 libpangocairo-1.0-0 libjpeg62-turbo libgif7 librsvg2-2 \
 && ln -sf "$(command -v fdfind)" /usr/local/bin/fd \
 && rm -f /etc/ssh/ssh_host_* \
 && mkdir -p /run/sshd \
 && usermod -p '*' node \
 && rm -rf /var/lib/apt/lists/*

COPY --from=uv /uv /uvx /usr/local/bin/

# Claude Code: default backend for the observer's bench helpers and the Claude Code benchmark arms.
# Pinned to a release at least 7 days old (same rule as .npmrc min-release-age).
RUN npm install -g --no-audit --no-fund @anthropic-ai/claude-code@2.1.278 && claude --version

ENV HOME=/home/node \
    TMPDIR=/tmp \
    PRIME_AGENT_KERNEL_VENV=/opt/prime-agent/kernel-venv \
    PRIME_AGENT_CODING_AGENT_DIR=/workspace/prime/agent \
    UV_CACHE_DIR=/opt/uv-cache \
    npm_config_cache=/opt/npm-cache \
    PRIME_OBSERVER_PORT=8790 \
    PRIME_OBSERVER_HOST=0.0.0.0 \
    DEPLOY_VOLUME=/workspace \
    DEPLOY_REPO_URL=git@github.com:erikcik/prime-agent-eray.git \
    DEPLOY_REPO_BRANCH=main \
    PI_SKIP_VERSION_CHECK=1

# --- build-time warm-up (discarded source; keeps caches + kernel venv) -------------------------
# Copy the repo, install + build once to warm the npm cache and bake the kernel venv, then drop /build.
COPY --chown=node:node . /build
WORKDIR /build
RUN mkdir -p /opt/prime-agent /opt/uv-cache /opt/npm-cache && chown -R node:node /opt/prime-agent /opt/uv-cache /opt/npm-cache
USER node
RUN npm ci --no-audit --no-fund \
 && bash deploy/build-harness.sh \
 && (cd observer && npm install --no-audit --no-fund && npm run build) \
 && PRIME_AGENT_INSTALL_UV=0 node_modules/.bin/tsx packages/coding-agent/src/core/kernel/bootstrap-cli.ts \
 && ls /opt/prime-agent/kernel-venv/bin/python
USER root
RUN rm -rf /build && chown -R node:node /opt/npm-cache /opt/uv-cache

# --- runtime wiring --------------------------------------------------------------------------
COPY deploy/sshd_config /etc/ssh/sshd_config
COPY deploy/entrypoint.sh deploy/healthcheck.sh deploy/refresh.sh deploy/run-observer.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/healthcheck.sh /usr/local/bin/refresh.sh /usr/local/bin/run-observer.sh \
 && mkdir -p /workspace /home/node/.ssh && chown -R node:node /workspace /home/node

WORKDIR /workspace
EXPOSE 8790 22
HEALTHCHECK --interval=30s --timeout=10s --start-period=600s --retries=3 CMD ["/usr/local/bin/healthcheck.sh"]
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["serve"]
