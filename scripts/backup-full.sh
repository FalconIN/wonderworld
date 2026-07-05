#!/bin/bash
# On-demand full backup: database dump + entire site directory (code, .env, configs).
# Excludes node_modules (reinstallable via npm install) and the backups/ dir itself.
set -euo pipefail

APP_DIR="/home/claudeuser/wonderworld"
BACKUP_DIR="$APP_DIR/backups"
LOG_FILE="$BACKUP_DIR/backup.log"
LOCAL_RETENTION_DAYS=3
REMOTE_RETENTION_DAYS=30

set -a
source "$APP_DIR/.env"
set +a

mkdir -p "$BACKUP_DIR"
timestamp=$(date +%Y-%m-%d_%H-%M-%S)

echo "[$timestamp] Starting full backup..." | tee -a "$LOG_FILE"

# 1. Database
dump_file="$BACKUP_DIR/wonderworld_${timestamp}.dump.gz"
PGPASSWORD="$PG_PASSWORD" pg_dump \
  -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$PG_DATABASE" \
  -Fc | gzip > "$dump_file"
rclone copy "$dump_file" "b2backup:${B2_BUCKET}/db-backups/" 2>&1 | tee -a "$LOG_FILE"
db_size=$(du -h "$dump_file" | cut -f1)
echo "[$timestamp] DB backup done: $(basename "$dump_file") (${db_size})" | tee -a "$LOG_FILE"

# 2. Full site directory (code, .env, configs) minus node_modules/backups/.git objects churn
site_archive="$BACKUP_DIR/wonderworld-site_${timestamp}.tar.gz"
tar -czf "$site_archive" \
  --exclude='node_modules' \
  --exclude='backups' \
  --exclude='.codex/skills/*/scripts/__pycache__' \
  -C /home/claudeuser wonderworld
rclone copy "$site_archive" "b2backup:${B2_BUCKET}/full-site-backups/" 2>&1 | tee -a "$LOG_FILE"
site_size=$(du -h "$site_archive" | cut -f1)
echo "[$timestamp] Site backup done: $(basename "$site_archive") (${site_size})" | tee -a "$LOG_FILE"

# Prune local files older than LOCAL_RETENTION_DAYS
find "$BACKUP_DIR" -name 'wonderworld_*.dump.gz' -mtime +"$LOCAL_RETENTION_DAYS" -delete
find "$BACKUP_DIR" -name 'wonderworld-site_*.tar.gz' -mtime +"$LOCAL_RETENTION_DAYS" -delete

# Prune remote files older than REMOTE_RETENTION_DAYS
rclone delete "b2backup:${B2_BUCKET}/db-backups/" --min-age "${REMOTE_RETENTION_DAYS}d" 2>&1 | tee -a "$LOG_FILE"
rclone delete "b2backup:${B2_BUCKET}/full-site-backups/" --min-age "${REMOTE_RETENTION_DAYS}d" 2>&1 | tee -a "$LOG_FILE"

echo "[$timestamp] Full backup complete." | tee -a "$LOG_FILE"
