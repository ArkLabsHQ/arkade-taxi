# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS build
WORKDIR /app

RUN corepack enable
# better-sqlite3 builds from source when no prebuilt binary matches.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/covenant/package.json packages/covenant/
COPY packages/core/package.json packages/core/
COPY packages/protocol/package.json packages/protocol/
COPY packages/db/package.json packages/db/
COPY packages/client/package.json packages/client/
COPY packages/app/package.json packages/app/
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm -r build \
    && pnpm deploy --legacy --filter @arkade-taxi/app --prod /out \
    && rm -rf /out/src \
    && find /out/node_modules/.pnpm -type d -path '*/node_modules/@arkade-taxi/*/src' \
        -prune -exec rm -rf '{}' + \
    && find /out -type d \( -name test -o -name tests -o -name docs -o -name .git -o -name .superpowers \) \
        -prune -exec rm -rf '{}' + \
    && find /out -type f \( \( -name '*.ts' ! -name '*.d.ts' \) -o -name '.env*' \
        -o -name 'tsconfig*.json' -o -name '*.md' \) -delete

FROM node:22-bookworm-slim AS runtime
ARG OCI_SOURCE=https://github.com/ArkLabsHQ/arkade-taxi
ARG OCI_REVISION=unknown
ARG OCI_VERSION=0.0.0
ARG OCI_LICENSE=MIT
ARG OCI_DESCRIPTION="Restart-safe Arkade liquidity and recovery service"
WORKDIR /app
ENV NODE_ENV=production

LABEL org.opencontainers.image.source=$OCI_SOURCE \
    org.opencontainers.image.revision=$OCI_REVISION \
    org.opencontainers.image.version=$OCI_VERSION \
    org.opencontainers.image.licenses=$OCI_LICENSE \
    org.opencontainers.image.description=$OCI_DESCRIPTION

COPY --from=build /out /app

RUN groupadd --gid 10001 taxi \
    && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin taxi \
    && install -d -o 10001 -g 10001 -m 0750 /data
USER 10001:10001

EXPOSE 8080
VOLUME ["/data"]
ENV TAXI_DB_PATH=/data/taxi.db TAXI_HTTP_PORT=8080

# Gates on /health (liveness), NOT /ready. A stale sweeper means arkd is
# unreachable, and restarting cannot make it reachable — probing /ready here
# would churn the container forever while hiding the cause. Point an
# orchestrator's readiness probe at /ready and alert on it; that is the signal
# that recovery is not running, which costs the operator money rather than
# merely blocking a payment.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.TAXI_HTTP_PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--experimental-eventsource", "--enable-source-maps", "dist/cli.js", "serve"]
