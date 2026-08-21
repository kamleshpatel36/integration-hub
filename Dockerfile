# Single image used by all four deployed services (api, worker, scheduler,
# backup) — render.yaml overrides CMD per service via `dockerCommand`.
# postgresql-client is here specifically so the backup service can run
# pg_dump/pg_restore; the other services don't need it but sharing one image
# keeps the build simple and guarantees the Prisma engine binary matches
# across all four.
FROM node:22-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends postgresql-client ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npx prisma generate
RUN npm run build

# Overridden per-service by render.yaml's `dockerCommand`; this default is
# only used if a service is run without an override (e.g. local `docker run`).
CMD ["node", "dist/index.js"]
