# syntax=docker/dockerfile:1
#
# Optional: for self-hosting. On Vercel you do NOT need this file (see docs/deployment.md).
#
#   docker build -t nando-smart-home .                   # the server (default target: runner)
#   docker build --target tools -t nando-tools .          # token CLI + database migrations
#
# No secret is ever baked into an image: configuration arrives at run time (env_file / environment).

ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-alpine AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# ---- dependencies (cached while package files are unchanged) ----
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci

# ---- build the self-contained server bundle ----
FROM deps AS build
COPY tsconfig.json next.config.ts ./
COPY src ./src
RUN npm run build
# Next.js copies .env files into the standalone output. .dockerignore keeps them out of this stage; this
# removes them again in case it is ever bypassed, so a secret can never reach the runtime image.
RUN rm -f .next/standalone/.env .next/standalone/.env.*

# ---- operator tools: `docker compose run --rm tools token -- list`, `... db:migrate` ----
FROM deps AS tools
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY db ./db
USER node
ENTRYPOINT ["npm", "run"]
CMD ["token", "--", "list"]

# ---- runtime: only the standalone bundle, as an unprivileged user ----
FROM base AS runner
ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=3000
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
USER node
EXPOSE 3000
# Liveness only (the anonymous health answer says the process is up, not that Tuya or the database are).
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
