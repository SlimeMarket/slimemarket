#!/usr/bin/env bash
#
# SlimeMarket — VPS provisioning script (Ubuntu 22.04/24.04 LTS)
#
# WHAT THIS DOES:
#   - System update + essential packages
#   - Docker + Docker Compose (official repo)
#   - Nginx + Certbot (Let's Encrypt)
#   - UFW firewall (22, 80, 443)
#   - Swap file (2 GB, kalau RAM < 4 GB)
#   - App directory + deploy user
#   - Logrotate for Nginx & Docker
#
# USAGE (run as root on a fresh VPS):
#   wget -qO- https://raw.githubusercontent.com/YOUR_REPO/main/scripts/vps-setup.sh | bash
#   OR copy this file to the VPS and run: bash vps-setup.sh
#
# AFTER THIS SCRIPT:
#   1. Copy your .env.production to /opt/slimemarket/.env.production
#   2. Clone/pull repo to /opt/slimemarket
#   3. Run scripts/deploy-vps.sh
#

set -euo pipefail

APP_NAME="slimemarket"
APP_DIR="/opt/${APP_NAME}"
DEPLOY_USER="deploy"
DOMAIN="${DOMAIN:-}"   # set via: DOMAIN=yourdomain.com bash vps-setup.sh

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[SETUP]${NC} $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
err()  { echo -e "${RED}[ERR]${NC} $*"; exit 1; }

if [[ $EUID -ne 0 ]]; then
   err "This script must be run as root (use sudo)"
fi

# =============================================================================
# 1. System basics
# =============================================================================
log "Updating system packages..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get upgrade -y -qq
apt-get install -y -qq \
    curl wget git jq htop ufw fail2ban \
    software-properties-common apt-transport-https ca-certificates \
    gnupg lsb-release logrotate

# =============================================================================
# 2. Docker + Docker Compose
# =============================================================================
if ! command -v docker &> /dev/null; then
    log "Installing Docker..."
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    chmod a+r /etc/apt/keyrings/docker.gpg
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" > /etc/apt/sources.list.d/docker.list
    apt-get update -qq
    apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
    systemctl enable docker
    systemctl start docker
else
    log "Docker already installed, skipping."
fi

# Ensure docker compose plugin works
docker compose version &> /dev/null || err "Docker Compose plugin failed to install"

# =============================================================================
# 3. Nginx + Certbot
# =============================================================================
if ! command -v nginx &> /dev/null; then
    log "Installing Nginx..."
    apt-get install -y -qq nginx
    systemctl enable nginx
    systemctl start nginx
else
    log "Nginx already installed, skipping."
fi

if ! command -v certbot &> /dev/null; then
    log "Installing Certbot..."
    apt-get install -y -qq certbot python3-certbot-nginx
else
    log "Certbot already installed, skipping."
fi

# =============================================================================
# 4. Firewall (UFW)
# =============================================================================
log "Configuring UFW firewall..."
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp comment 'SSH'
ufw allow 80/tcp comment 'HTTP'
ufw allow 443/tcp comment 'HTTPS'
ufw --force enable

# =============================================================================
# 5. Swap (kalau RAM < 4 GB, build Docker butuh banyak RAM)
# =============================================================================
TOTAL_RAM_KB=$(grep MemTotal /proc/meminfo | awk '{print $2}')
TOTAL_RAM_GB=$((TOTAL_RAM_KB / 1024 / 1024))

if [[ $TOTAL_RAM_GB -lt 4 && ! -f /swapfile ]]; then
    log "RAM is ${TOTAL_RAM_GB}GB (< 4GB). Creating 2GB swap file..."
    fallocate -l 2G /swapfile
    chmod 600 /swapfile
    mkswap /swapfile
    swapon /swapfile
    echo '/swapfile none swap sw 0 0' >> /etc/fstab
    sysctl vm.swappiness=10
    echo 'vm.swappiness=10' >> /etc/sysctl.conf
else
    log "RAM is ${TOTAL_RAM_GB}GB. Swap setup skipped."
fi

# =============================================================================
# 6. App directory & deploy user
# =============================================================================
log "Creating app directory ${APP_DIR}..."
mkdir -p "${APP_DIR}"
mkdir -p "${APP_DIR}/nginx"
mkdir -p /var/www/certbot

if ! id -u "${DEPLOY_USER}" &>/dev/null; then
    log "Creating deploy user: ${DEPLOY_USER}..."
    useradd -m -s /bin/bash "${DEPLOY_USER}"
    usermod -aG docker "${DEPLOY_USER}"
    log "Deploy user created. Set a password if you want SSH login: passwd ${DEPLOY_USER}"
else
    usermod -aG docker "${DEPLOY_USER}" 2>/dev/null || true
fi

chown -R "${DEPLOY_USER}:${DEPLOY_USER}" "${APP_DIR}"

# =============================================================================
# 7. Logrotate
# =============================================================================
log "Configuring logrotate..."
cat > /etc/logrotate.d/slimemarket << 'EOF'
/var/log/nginx/slimemarket.*.log {
    daily
    missingok
    rotate 14
    compress
    delaycompress
    notifempty
    create 0640 www-data adm
    sharedscripts
    postrotate
        [ -f /var/run/nginx.pid ] && kill -USR1 $(cat /var/run/nginx.pid)
    endscript
}

/var/lib/docker/containers/*/*.log {
    daily
    missingok
    rotate 7
    compress
    delaycompress
    notifempty
    copytruncate
}
EOF

# =============================================================================
# 8. Fail2ban (basic SSH protection)
# =============================================================================
log "Enabling fail2ban..."
systemctl enable fail2ban
systemctl start fail2ban

# =============================================================================
# 9. Kernel hardening (optional but recommended)
# =============================================================================
log "Applying basic sysctl hardening..."
cat >> /etc/sysctl.conf << 'EOF'
# Security
net.ipv4.conf.all.rp_filter=1
net.ipv4.conf.default.rp_filter=1
net.ipv4.icmp_echo_ignore_broadcasts=1
net.ipv4.tcp_syncookies=1
EOF
sysctl -p &> /dev/null || true

# =============================================================================
# Done
# =============================================================================
echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  VPS SETUP COMPLETE${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo "Next steps:"
echo "  1. Clone your repo to ${APP_DIR}"
echo "  2. Copy .env.production to ${APP_DIR}/.env.production"
echo "  3. Copy nginx/slimemarket.conf to /etc/nginx/sites-available/"
echo "     and replace YOUR_DOMAIN.COM with your real domain."
echo "  4. Obtain SSL: certbot --nginx -d yourdomain.com -d www.yourdomain.com"
echo "  5. Run: cd ${APP_DIR} && bash scripts/deploy-vps.sh"
echo ""
if [[ -z "${DOMAIN:-}" ]]; then
    warn "DOMAIN not set. Remember to set it in Nginx config before certbot."
else
    log "Domain set to: ${DOMAIN}"
fi
