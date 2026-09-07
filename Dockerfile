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
RUN pnpm -r build && pnpm deploy --filter @arkade-taxi/app --prod /out

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /out /app

RUN useradd --system --uid 10001 taxi && chown -R taxi:taxi /app /data 2>/dev/null || true
USER taxi

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

CMD ["node", "--enable-source-maps", "dist/cli.js", "serve"]
