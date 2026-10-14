#!/usr/bin/env bash
#
# SlimeMarket — VPS deploy script (Docker Compose path)
#
# WHAT THIS DOES:
#   - Sanity-check .env.production exists and has required keys
#   - Build the Docker image (web + scheduler from one Dockerfile)
#   - Gracefully rolling-update the containers
#   - Wait for health endpoint to return 200
#   - Prune old images
#
# USAGE:
#   cd /opt/slimemarket
#   bash scripts/deploy-vps.sh
#
# REQUIREMENTS on the VPS:
#   - Docker + docker compose plugin
#   - .env.production in the repo root (gitignored, filled with real secrets)
#   - Nginx reverse proxy forwarding 127.0.0.1:3000 (already configured)
#

set -euo pipefail

APP_NAME="slimemarket"
ENV_FILE=".env.production"
HEALTH_URL="http://127.0.0.1:3000/api/health"
MAX_HEALTH_WAIT=120  # seconds

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[DEPLOY]${NC} $*"; }
warn() { echo -e "${YELLOW}[DEPLOY]${NC} $*"; }
err()  { echo -e "${RED}[DEPLOY]${NC} $*"; exit 1; }

# =============================================================================
# 0. Pre-flight checks
# =============================================================================
log "Starting deploy for ${APP_NAME}..."

if [[ ! -f "${ENV_FILE}" ]]; then
    err "${ENV_FILE} not found in $(pwd). Create it from .env.example first."
fi

# Minimal env sanity — fail fast if critical keys are literally empty or still placeholders
required_vars=(
    NEXT_PUBLIC_APP_URL
    NEXT_PUBLIC_SUPABASE_URL
    SUPABASE_SECRET_KEY
    CIRCLE_API_KEY
    ARC_RPC_URL
    ESCROW_CONTRACT_ADDRESS
)

missing=0
for var in "${required_vars[@]}"; do
    val=$(grep "^${var}=" "${ENV_FILE}" | cut -d= -f2- | sed 's/^[[:space:]]*//')
    if [[ -z "${val}" || "${val}" == "<"* ]]; then
        err "${var} is missing or still a placeholder in ${ENV_FILE}"
        missing=$((missing + 1))
    fi
done

if [[ $missing -gt 0 ]]; then
    err "Fix the ${missing} missing variable(s) above before deploying."
fi

if ! docker compose version &> /dev/null && ! docker-compose version &> /dev/null; then
    err "Docker Compose not found. Install it first (see scripts/vps-setup.sh)."
fi

COMPOSE_CMD="docker compose"
if ! docker compose version &> /dev/null; then
    COMPOSE_CMD="docker-compose"
fi

# =============================================================================
# 1. Build
# =============================================================================
log "Building Docker image (this may take 2–5 minutes)..."
${COMPOSE_CMD} --env-file "${ENV_FILE}" build web

# =============================================================================
# 2. Deploy (rolling update)
# =============================================================================
log "Stopping old scheduler (so it doesn't hit a dying web container)..."
${COMPOSE_CMD} --env-file "${ENV_FILE}" stop scheduler || true

log "Bringing up web + scheduler..."
${COMPOSE_CMD} --env-file "${ENV_FILE}" up -d

# =============================================================================
# 3. Health check
# =============================================================================
log "Waiting for /api/health (max ${MAX_HEALTH_WAIT}s)..."

for i in $(seq 1 $MAX_HEALTH_WAIT); do
    status_code=$(curl -s -o /dev/null -w "%{http_code}" "${HEALTH_URL}" || echo "000")
    if [[ "${status_code}" == "200" || "${status_code}" == "503" ]]; then
        log "Health endpoint responded HTTP ${status_code} after ${i}s."
        break
    fi
    if [[ $i -eq $MAX_HEALTH_WAIT ]]; then
        err "Health check never returned 200/503. Last code: ${status_code}."
        err "Check logs: ${COMPOSE_CMD} logs -f web"
        exit 1
    fi
    sleep 1
done

# Give it a few more seconds if it was 503 (degraded = still booting)
if [[ "${status_code}" == "503" ]]; then
    log "Status is DEGRADED (expected during boot). Waiting another 15s..."
    sleep 15
    status_code=$(curl -s -o /dev/null -w "%{http_code}" "${HEALTH_URL}" || echo "000")
    if [[ "${status_code}" != "200" ]]; then
        warn "Still not fully OK (HTTP ${status_code}). Check /api/health manually."
    fi
fi

# =============================================================================
# 4. Quick JSON health summary
# =============================================================================
log "Fetching health details..."
curl -s "${HEALTH_URL}" | jq . 2>/dev/null || curl -s "${HEALTH_URL}"

# =============================================================================
# 5. Cleanup
# =============================================================================
log "Pruning old Docker images..."
docker image prune -f &> /dev/null || true

# =============================================================================
# Done
# =============================================================================
echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  DEPLOY COMPLETE${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo "Services:"
# --env-file is REQUIRED here too: without it compose cannot resolve the
# ${NEXT_PUBLIC_*} build args and prints a wall of "variable is not set —
# defaulting to a blank string" warnings that look like a broken build.
${COMPOSE_CMD} --env-file "${ENV_FILE}" ps

echo ""
echo "Useful commands:"
echo "  Logs web:       ${COMPOSE_CMD} --env-file ${ENV_FILE} logs -f web"
echo "  Logs scheduler: ${COMPOSE_CMD} --env-file ${ENV_FILE} logs -f scheduler"
echo "  Health:         curl ${HEALTH_URL}"
echo "  Restart:        ${COMPOSE_CMD} --env-file ${ENV_FILE} restart web"
echo ""
