#!/usr/bin/env bash
# Rebuild the local container from the working tree and restart it, so a
# change can be tried in the running app. This is the test loop after every
# change; it publishes nothing.
#
#   tools/redeploy.sh
set -euo pipefail
cd "$(dirname "$0")/.."

docker compose up -d --build
name=$(docker compose ps -q | head -1)
for _ in $(seq 1 60); do
    status=$(docker inspect --format '{{.State.Health.Status}}' "$name" 2>/dev/null || echo unknown)
    if [ "$status" = healthy ]; then
        echo "Up and healthy: http://localhost:${PORT:-$(sed -n 's/^PORT=//p' .env 2>/dev/null || echo 8000)}"
        exit 0
    fi
    sleep 1
done
echo "The container did not become healthy ($status). Logs:" >&2
docker compose logs --tail 40 >&2
exit 1
