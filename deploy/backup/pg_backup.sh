#!/usr/bin/env bash
# Daily logical backup of the practice database, separate from the machine-level Acronis backup.
# Run from cron as root, e.g.:  15 2 * * * /opt/byh-flow/deploy/backup/pg_backup.sh
# Backs up the database only. The encrypted files volume ('byh-flow_files') must be in the
# Acronis critical-folder list or copied alongside. The FILE_ENCRYPTION_KEY must NOT be stored with these.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/byh-flow}"
OUT_DIR="${OUT_DIR:-/var/backups/byh-flow}"
KEEP_DAYS="${KEEP_DAYS:-14}"

set -a; . "$APP_DIR/.env"; set +a
mkdir -p "$OUT_DIR"; chmod 700 "$OUT_DIR"

stamp="$(date +%Y%m%d-%H%M%S)"
out="$OUT_DIR/byhflow-$stamp.dump"

# pg_dump runs inside the db container, so its version always matches the server.
docker compose -f "$APP_DIR/docker-compose.yml" exec -T db \
  pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner > "$out"

chmod 600 "$out"
find "$OUT_DIR" -name 'byhflow-*.dump' -mtime +"$KEEP_DAYS" -delete
echo "backup written: $out"
