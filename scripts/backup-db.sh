#!/bin/bash
# Nightly Postgres backup -> Backblaze B2 (off-site).
# Runs via cron; see crontab -l.
set -euo pipefail

APP_DIR="/home/claudeuser/wonderworld"
BACKUP_DIR="$APP_DIR/backups"
LOG_FILE="$APP_DIR/backups/backup.log"
LOCAL_RETENTION_DAYS=3
REMOTE_RETENTION_DAYS=30

set -a
source "$APP_DIR/.env"
set +a

mkdir -p "$BACKUP_DIR"
timestamp=$(date +%Y-%m-%d_%H-%M-%S)
dump_file="$BACKUP_DIR/wonderworld_${timestamp}.dump.gz"

echo "[$timestamp] Starting backup..." | tee -a "$LOG_FILE"

PGPASSWORD="$PG_PASSWORD" pg_dump \
  -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$PG_DATABASE" \
  -Fc | gzip > "$dump_file"

rclone copy "$dump_file" "b2backup:${B2_BUCKET}/db-backups/" 2>&1 | tee -a "$LOG_FILE"

# Prune local dumps older than LOCAL_RETENTION_DAYS (Aquatis snapshots + B2 cover longer retention)
find "$BACKUP_DIR" -name 'wonderworld_*.dump.gz' -mtime +"$LOCAL_RETENTION_DAYS" -delete

# Prune remote dumps older than REMOTE_RETENTION_DAYS
rclone delete "b2backup:${B2_BUCKET}/db-backups/" --min-age "${REMOTE_RETENTION_DAYS}d" 2>&1 | tee -a "$LOG_FILE"

size=$(du -h "$dump_file" | cut -f1)
echo "[$timestamp] Backup finished: $(basename "$dump_file") (${size}) -> uploaded to b2backup:${B2_BUCKET}/db-backups/" | tee -a "$LOG_FILE"
