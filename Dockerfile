FROM node:22-slim
ARG TARGETARCH

# Claude Code CLI, used for answering registration questions (auth via CLAUDE_CODE_OAUTH_TOKEN)
RUN npm install -g @anthropic-ai/claude-code

# The browser for the selector flow (SERVER_MODE=selector): it runs as a plain process and Patchright
# attaches to it (see selectorRunner.ts). Google Chrome on amd64 (Railway); it has no Linux arm64 build,
# so an arm64 build (local Docker on an Apple Silicon Mac) gets Debian's Chromium instead.
# Extra fonts so pages render like on a desktop.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates wget fonts-noto-color-emoji fonts-noto-cjk \
    && if [ "$TARGETARCH" = "amd64" ]; then \
        wget -q -O /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
        && apt-get install -y --no-install-recommends /tmp/chrome.deb \
        && rm /tmp/chrome.deb; \
    else \
        apt-get install -y --no-install-recommends chromium; \
    fi \
    && rm -rf /var/lib/apt/lists/*
# Chrome flags for running inside a container (chromeLaunchArgs in browserConfig.ts)
ENV CHROME_IN_CONTAINER=true

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
# Owned by node: the bot runs as node, and files only readable by their owner on the build machine
# would be unreadable otherwise
COPY --chown=node:node tsconfig.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node profiles ./profiles
# The bot writes chrome_profiles/, logs/ and debug files under /app
RUN chown node:node /app

# Run as the image's unprivileged user
USER node

CMD ["npx", "ts-node", "src/api_flow/server.ts"]
