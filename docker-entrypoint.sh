#!/bin/sh
# Baked into the Docker image as the default CMD (see Dockerfile). Runs
# migrations, then starts the API. Exists specifically so the API service's
# "Docker Command" field in Render can be left BLANK — typing a compound
# `sh -c "a && b"` command into that field ran into a quoting/parsing issue
# where Render didn't invoke it through a real shell, so `&&` was treated as
# part of a literal (non-existent) command name instead of a shell operator.
# Baking the logic into the image sidesteps that entirely.
set -e

echo "Running database migrations..."
npx prisma migrate deploy

echo "Starting API server..."
exec node dist/index.js
