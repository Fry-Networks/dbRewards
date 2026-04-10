#!/bin/bash
# Auto-retry script for dbrewards containers after 1Password rate limit.
# Tests 1Password API before starting. Self-removes cron on success.
set -euo pipefail

LOG="/var/log/dbrewards-retry.log"
COMPOSE_DIR="/home/fryadmin/projects/dbRewards"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S'): $*" >> "$LOG"; }

log "Checking 1Password rate limit..."

# Load service account token
TOKEN=$(cat /etc/opt/dbrewards/op_service_account_token 2>/dev/null) || {
  log "ERROR — Cannot read service account token"
  exit 1
}

# Test if 1Password vault access works
export OP_SERVICE_ACCOUNT_TOKEN="$TOKEN"
RESULT=$(op vault list 2>&1) || true

if echo "$RESULT" | grep -qi "rate\|limit\|Too many"; then
  log "Still rate-limited. Skipping."
  exit 0
fi

if echo "$RESULT" | grep -qi "error\|fail"; then
  log "1Password error (not rate limit): $RESULT"
  exit 1
fi

log "Rate limit cleared! Rebuilding containers..."

# Rebuild and start both containers
cd "$COMPOSE_DIR"
docker compose up -d --build >> "$LOG" 2>&1 || {
  log "ERROR — docker compose build failed"
  exit 1
}

# Wait for containers to start
sleep 30

PROD_RUNNING=$(docker inspect dbrewards-prod --format '{{.State.Running}}' 2>/dev/null || echo "false")
WEEKLY_RUNNING=$(docker inspect dbrewards-weekly --format '{{.State.Running}}' 2>/dev/null || echo "false")
log "After 30s — prod: $PROD_RUNNING, weekly: $WEEKLY_RUNNING"

if [ "$PROD_RUNNING" != "true" ] || [ "$WEEKLY_RUNNING" != "true" ]; then
  log "Containers failed to start. Stopping to preserve quota..."
  docker stop dbrewards-prod dbrewards-weekly 2>/dev/null || true
  docker update --restart=no dbrewards-prod dbrewards-weekly 2>/dev/null || true
  log "Will retry next cron cycle."
  exit 1
fi

# Stability check — wait another 30s and recheck
sleep 30

PROD_STILL=$(docker inspect dbrewards-prod --format '{{.State.Running}}' 2>/dev/null || echo "false")
WEEKLY_STILL=$(docker inspect dbrewards-weekly --format '{{.State.Running}}' 2>/dev/null || echo "false")
log "After 60s — prod: $PROD_STILL, weekly: $WEEKLY_STILL"

if [ "$PROD_STILL" != "true" ] || [ "$WEEKLY_STILL" != "true" ]; then
  log "Containers crashed after start. Stopping to preserve quota..."
  docker stop dbrewards-prod dbrewards-weekly 2>/dev/null || true
  docker update --restart=no dbrewards-prod dbrewards-weekly 2>/dev/null || true
  log "Will retry next cron cycle."
  exit 1
fi

# Containers stable — restore restart policy
log "Containers stable! Restoring restart policy..."
docker update --restart=unless-stopped dbrewards-prod
docker update --restart=unless-stopped dbrewards-weekly
log "Restart policy restored to unless-stopped."

# Wait for health checks
sleep 60
PROD_HEALTH=$(docker inspect dbrewards-prod --format '{{.State.Health.Status}}' 2>/dev/null || echo "unknown")
WEEKLY_HEALTH=$(docker inspect dbrewards-weekly --format '{{.State.Health.Status}}' 2>/dev/null || echo "unknown")
log "Health — prod: $PROD_HEALTH, weekly: $WEEKLY_HEALTH"

# Self-remove cron entry
log "Removing auto-retry cron job..."
(crontab -l 2>/dev/null | grep -v "check-and-restart") | crontab - 2>/dev/null || true
log "SUCCESS — Containers running, restart policy restored, cron removed."
