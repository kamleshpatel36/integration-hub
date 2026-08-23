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
RUN chmod +x docker-entrypoint.sh
RUN npx prisma generate
RUN npm run build

# Default CMD runs migrations then starts the API — this is what the
# integration-hub-api service uses when its "Docker Command" field is left
# BLANK in Render. worker/scheduler/backup services override this with a
# simple single command (e.g. "node dist/queue/worker.js") via render.yaml's
# `dockerCommand` — those are plain single commands with no `&&`, so they
# don't hit the compound-command parsing issue this script works around.
CMD ["./docker-entrypoint.sh"]
