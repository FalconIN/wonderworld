#!/bin/bash
# Restore the database from a backup (local file or Backblaze B2).
# Usage:
#   ./restore-db.sh --list                     List available backups (local + B2)
#   ./restore-db.sh <file.dump.gz> --confirm    Restore from a specific backup (downloads from B2 if not found locally)
#
# WARNING: this overwrites the live database. Requires --confirm.
set -euo pipefail

APP_DIR="/home/claudeuser/wonderworld"
BACKUP_DIR="$APP_DIR/backups"

set -a
source "$APP_DIR/.env"
set +a

if [[ "${1:-}" == "--list" ]]; then
  echo "== Local backups =="
  ls -1 "$BACKUP_DIR"/wonderworld_*.dump.gz 2>/dev/null || echo "(none)"
  echo
  echo "== Backblaze backups =="
  rclone ls "b2backup:${B2_BUCKET}/db-backups/"
  exit 0
fi

file="${1:-}"
confirm="${2:-}"

if [[ -z "$file" || "$confirm" != "--confirm" ]]; then
  echo "Usage: $0 <backup-filename.dump.gz> --confirm"
  echo "Run '$0 --list' to see available backups first."
  exit 1
fi

local_path="$BACKUP_DIR/$(basename "$file")"

if [[ ! -f "$local_path" ]]; then
  echo "Not found locally, downloading from B2..."
  rclone copy "b2backup:${B2_BUCKET}/db-backups/$(basename "$file")" "$BACKUP_DIR/"
fi

echo "Restoring $local_path into database '$PG_DATABASE' on $PG_HOST..."
echo "This will DROP and recreate existing objects. Ctrl+C now to abort."
sleep 5

gunzip -c "$local_path" | PGPASSWORD="$PG_PASSWORD" pg_restore \
  -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$PG_DATABASE" \
  --clean --if-exists --no-owner

echo "Restore complete."
