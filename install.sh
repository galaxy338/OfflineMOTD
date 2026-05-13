#!/bin/bash
# ──────────────────────────────────────────────────────────────
#  OfflineMOTD — One-Line Installer
#
#  Usage:
#    bash <(curl -s https://raw.githubusercontent.com/galaxy338/OfflineMOTD/main/install.sh)
#
#  What it does:
#    1. Checks for Node.js 18+
#    2. Clones the repo to /opt/offlinemotd
#    3. Creates a default config.json
#    4. Sets up a systemd service
#    5. Starts the service
# ──────────────────────────────────────────────────────────────

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

INSTALL_DIR="/opt/offlinemotd"
SERVICE_NAME="offlinemotd"
REPO_URL="https://github.com/galaxy338/OfflineMOTD.git"

# ─── Banner ──────────────────────────────────────────────────
echo ""
echo -e "${CYAN}${BOLD}   ╔═╗┌─┐┌─┐┬  ┬┌┐┌┌─┐╔╦╗╔═╗╔╦╗╔╦╗${NC}"
echo -e "${CYAN}   ║ ║├┤ ├┤ │  ││││├┤ ║║║║ ║ ║  ║║${NC}"
echo -e "${BLUE}   ╚═╝└  └  ┴─┘┴┘└┘└─┘╩ ╩╚═╝ ╩ ═╩╝${NC}"
echo -e "${DIM}   Installer v1.0${NC}"
echo -e "${DIM}   ─────────────────────────────────────${NC}"
echo ""

# ─── Helper functions ────────────────────────────────────────
ok()   { echo -e "  ${GREEN}✔${NC} $1"; }
fail() { echo -e "  ${RED}✖${NC} $1"; exit 1; }
info() { echo -e "  ${BLUE}→${NC} $1"; }
warn() { echo -e "  ${YELLOW}⚠${NC} $1"; }
ask()  { echo -ne "  ${CYAN}?${NC} $1"; }

# ─── Check root ──────────────────────────────────────────────
if [ "$EUID" -ne 0 ]; then
    fail "Please run as root: sudo bash install.sh"
fi

# ─── Check Node.js ───────────────────────────────────────────
info "Checking Node.js..."
if ! command -v node &> /dev/null; then
    warn "Node.js not found."
    ask "Install Node.js 20 LTS? (y/N): "
    read -r INSTALL_NODE
    if [[ "$INSTALL_NODE" =~ ^[Yy]$ ]]; then
        info "Installing Node.js 20 via NodeSource..."
        curl -fsSL https://deb.nodesource.com/setup_20.x | bash - > /dev/null 2>&1
        apt-get install -y nodejs > /dev/null 2>&1
        ok "Node.js $(node -v) installed"
    else
        fail "Node.js 18+ is required. Install it and try again."
    fi
else
    NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
    if [ "$NODE_VERSION" -lt 18 ]; then
        fail "Node.js 18+ required (found v$(node -v)). Please upgrade."
    fi
    ok "Node.js $(node -v) found"
fi

# ─── Check git ───────────────────────────────────────────────
if ! command -v git &> /dev/null; then
    info "Installing git..."
    apt-get install -y git > /dev/null 2>&1
    ok "git installed"
fi

# ─── Clone or update repo ───────────────────────────────────
if [ -d "$INSTALL_DIR" ]; then
    warn "OfflineMOTD already installed at $INSTALL_DIR"
    ask "Update to latest version? (y/N): "
    read -r DO_UPDATE
    if [[ "$DO_UPDATE" =~ ^[Yy]$ ]]; then
        info "Updating..."
        cd "$INSTALL_DIR"
        # Preserve config
        if [ -f config.json ]; then
            cp config.json config.json.bak
        fi
        if [ -f server-icon.png ]; then
            cp server-icon.png server-icon.png.bak
        fi
        git pull origin main > /dev/null 2>&1
        # Restore config
        if [ -f config.json.bak ]; then
            mv config.json.bak config.json
        fi
        if [ -f server-icon.png.bak ]; then
            mv server-icon.png.bak server-icon.png
        fi
        ok "Updated to latest version"
    else
        info "Skipping update"
    fi
else
    info "Cloning OfflineMOTD to $INSTALL_DIR..."
    git clone "$REPO_URL" "$INSTALL_DIR" > /dev/null 2>&1
    ok "Cloned to $INSTALL_DIR"
fi

cd "$INSTALL_DIR"

# ─── Configure ──────────────────────────────────────────────
if [ ! -f config.json ] || ! grep -q "panelUrl" config.json 2>/dev/null; then
    echo ""
    echo -e "  ${BOLD}Configuration${NC}"
    echo -e "  ${DIM}──────────────${NC}"
    echo ""

    ask "Pterodactyl Panel URL (e.g., https://panel.example.com): "
    read -r PANEL_URL

    ask "Application API Key (Admin → Application API): "
    read -r APP_KEY

    ask "Client API Key (Account → API Credentials): "
    read -r CLIENT_KEY

    ask "Deployment mode (standalone/controller/agent) [standalone]: "
    read -r MODE
    MODE=${MODE:-standalone}

    cat > config.json << ENDCONFIG
{
  "mode": "${MODE}",
  "pterodactyl": {
    "panelUrl": "${PANEL_URL}",
    "apiKey": "${APP_KEY}",
    "clientApiKey": "${CLIENT_KEY}",
    "pollIntervalMs": 60000
  },
  "http": {
    "port": 3100
  },
  "motd": {
    "offline": {
      "line1": "§7This server is currently offline.",
      "maxPlayers": 0,
      "onlinePlayers": 0,
      "playerSample": [],
      "kickMessage": "§c§lServer Offline\n\n§7{SERVER_NAME} is currently offline.\n§7Please try again later.",
      "ads": []
    },
    "suspended": {
      "line1": "§4§l⛔ Server Suspended",
      "maxPlayers": 0,
      "onlinePlayers": 0,
      "playerSample": [],
      "kickMessage": "§4§lServer Suspended\n\n§c{SERVER_NAME} has been suspended.\n§cPlease contact an administrator.",
      "ads": []
    },
    "installing": {
      "line1": "§e§l⏳ Installing...",
      "line2": "§7{SERVER_NAME} is being set up. Please wait.",
      "maxPlayers": 0,
      "onlinePlayers": 0,
      "playerSample": [],
      "kickMessage": "§e§lServer Installing\n\n§7Please check back in a few minutes."
    },
    "starting": {
      "line1": "§a§l▶ Starting...",
      "line2": "§7{SERVER_NAME} is booting up. Almost ready!",
      "maxPlayers": 0,
      "onlinePlayers": 0,
      "playerSample": [],
      "kickMessage": "§a§lServer Starting\n\n§7Please wait a moment and try again."
    }
  },
  "minecraft": {
    "version": "1.21.5",
    "protocol": 770,
    "icon": "./server-icon.png"
  },
  "rateLimit": {
    "maxConnections": 10,
    "windowMs": 60000
  },
  "controller": {
    "authToken": "change-me-to-a-secret"
  },
  "agent": {
    "controllerUrl": "http://panel-ip:3100",
    "authToken": "change-me-to-a-secret",
    "nodeId": 1,
    "agentPort": 3200,
    "pollIntervalMs": 15000
  }
}
ENDCONFIG

    ok "Configuration saved"
else
    ok "Existing config.json found — keeping it"
fi

# ─── Setup systemd service ──────────────────────────────────
info "Setting up systemd service..."

cat > /etc/systemd/system/${SERVICE_NAME}.service << ENDSERVICE
[Unit]
Description=OfflineMOTD — Pterodactyl Fake MOTD Server
After=network.target

[Service]
Type=simple
WorkingDirectory=${INSTALL_DIR}
ExecStart=$(which node) index.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${SERVICE_NAME}

[Install]
WantedBy=multi-user.target
ENDSERVICE

systemctl daemon-reload
systemctl enable ${SERVICE_NAME} > /dev/null 2>&1
ok "Systemd service created and enabled"

# ─── Start ──────────────────────────────────────────────────
ask "Start OfflineMOTD now? (Y/n): "
read -r START_NOW
START_NOW=${START_NOW:-Y}

if [[ "$START_NOW" =~ ^[Yy]$ ]]; then
    systemctl restart ${SERVICE_NAME}
    sleep 2
    if systemctl is-active --quiet ${SERVICE_NAME}; then
        ok "OfflineMOTD is running!"
    else
        warn "Service started but may have issues. Check logs:"
        echo -e "    ${DIM}journalctl -u ${SERVICE_NAME} -f${NC}"
    fi
else
    info "Start later with: systemctl start ${SERVICE_NAME}"
fi

# ─── Done ───────────────────────────────────────────────────
echo ""
echo -e "  ${GREEN}${BOLD}✅ Installation complete!${NC}"
echo ""
echo -e "  ${DIM}Useful commands:${NC}"
echo -e "    ${CYAN}systemctl status ${SERVICE_NAME}${NC}     — Check status"
echo -e "    ${CYAN}systemctl restart ${SERVICE_NAME}${NC}    — Restart"
echo -e "    ${CYAN}journalctl -u ${SERVICE_NAME} -f${NC}     — View logs"
echo -e "    ${CYAN}nano ${INSTALL_DIR}/config.json${NC}  — Edit config"
echo -e "    ${CYAN}cd ${INSTALL_DIR} && node update.js${NC} — Update"
echo ""
