FROM node:22-slim AS build

RUN apt-get update && apt-get install -y --no-install-recommends git openssh-client default-mysql-client \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci 2>/dev/null || npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      git openssh-client default-mysql-client ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Non-root user; home holds .ssh (mounted key) and .pi agent dir
RUN useradd --create-home --shell /bin/bash ppa && mkdir -p /work /home/ppa/.ssh /home/ppa/.pi/agent \
    && chown -R ppa:ppa /work /home/ppa

WORKDIR /app
COPY --from=build --chown=ppa:ppa /app/node_modules ./node_modules
COPY --from=build --chown=ppa:ppa /app/dist ./dist
COPY --chown=ppa:ppa slack-manifest.yml README.md ./

USER ppa
ENV PPA_CONFIG=/app/ppa.yml \
    PPA_WORKSPACE=/work \
    PPA_AGENT_DIR=/home/ppa/.pi/agent \
    NODE_ENV=production

# Fail fast on bad SSH host keys instead of hanging: strict checking, no prompt
RUN printf 'Host *\n  StrictHostKeyChecking accept-new\n  BatchMode yes\n' > /home/ppa/.ssh/config

HEALTHCHECK --interval=60s --timeout=10s --start-period=30s \
  CMD node -e "process.env.SLACK_APP_TOKEN ? process.exit(0) : process.exit(1)"

CMD ["node", "dist/index.js"]
