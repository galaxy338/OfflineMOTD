# OfflineMOTD

**Pterodactyl-aware fake Minecraft MOTD server** — automatically discovers ALL your servers from the Pterodactyl Panel API. When a server is offline, suspended, installing, or starting, it shows a custom MOTD with **rotating ads** on that port. When the server comes online, it releases the port seamlessly.

**Zero server configuration needed** — just provide your Pterodactyl API keys and it handles everything.

<img width="619" height="92" alt="image" src="https://github.com/user-attachments/assets/c703fabd-7a71-41a9-8747-7edea7516954" />

---

## Features

- 🔍 **Auto-Discovery** — Fetches ALL servers from Pterodactyl automatically (with pagination)
- 🎯 **Dynamic MOTD** — Different messages for offline, suspended, installing, and starting states
- 📢 **Rotating Ads** — Cycle through multiple ads on line 2 (each refresh shows the next ad)
- 🖥️ **Multi-Server** — Monitors every server on your panel simultaneously
- 🌐 **Multi-Node** — Controller + Agent architecture for multiple Wings nodes
- ⚡ **Power Control** — Start/stop real servers via API (stops MOTD → releases port → starts server)
- 🔄 **Seamless Port Handoff** — No "port already in use" errors
- 🛡️ **IP Rate Limiting** — Configurable per-IP connection throttling
- 🔄 **Auto-Update** — `node update.js` pulls latest from GitHub, preserves config
- 📦 **Zero Dependencies** — Pure Node.js, no `npm install` needed
- 🔁 **Auto-Refresh** — Picks up new servers added to the panel automatically

---

## Quick Start

### One-Line Install (Linux)

```bash
bash <(curl -s https://raw.githubusercontent.com/galaxy338/OfflineMOTD/main/install.sh)
```

This handles everything: Node.js check, download, config setup, and systemd service.

### Manual Setup

#### 1. Install Node.js 18+

### 2. Configure

Edit `config.json` — you only need your Pterodactyl credentials:

```json
{
  "mode": "standalone",
  "pterodactyl": {
    "panelUrl": "https://panel.example.com",
    "apiKey": "YOUR_APPLICATION_API_KEY",
    "clientApiKey": "YOUR_CLIENT_API_KEY",
    "pollIntervalMs": 60000
  },
  "http": {
    "port": 3100
  }
}
```

That's it. No server list needed — OfflineMOTD discovers everything automatically.

### 3. Get API Keys

| Key | Where | Purpose |
|-----|-------|---------|
| `apiKey` (Application) | Admin → Application API | List servers, check suspended |
| `clientApiKey` (Client) | Account → API Credentials | Power state + power control |

### 4. Run

```bash
node index.js
```

You'll see it discover and register all your servers:

```
[12:00:00] [OK]     [Pterodactyl] Discovered: Survival (ID: 1) — Port 25565
[12:00:00] [OK]     [Pterodactyl] Discovered: Creative (ID: 2) — Port 25566
[12:00:00] [INFO]   [Pterodactyl] Total servers: 3 (3 new)
[12:00:01] [API]    [Pterodactyl] [Survival] INIT → OFFLINE
[12:00:01] [SERVER] [Main] [Survival] OFFLINE — starting fake MC on port 25565...
```

---

## How It Works

1. **Startup** → Calls `GET /api/application/servers?include=allocations` to find ALL servers + their ports
2. **Per server**: checks if offline/suspended/installing/starting → starts fake MC on that port
3. **Online servers** → no fake MC (real server has the port)
4. **Every 60s** → re-polls all servers, picks up new ones, handles state changes
5. **Power control** → `POST /api/power/Survival/start` releases port + starts real server

---

## Modes

OfflineMOTD supports three deployment modes:

### Standalone (Default)

Everything runs in one process. Best for single-node setups.

```json
{ "mode": "standalone" }
```

### Controller + Agent (Multi-Node)

For multiple Wings nodes. Controller runs on the panel VPS, agents run on each node.

```
Panel VPS (Controller)                 Node A (Agent)           Node B (Agent)
┌─────────────────────┐    HTTP/Auth   ┌────────────────┐      ┌────────────────┐
│ Pterodactyl API     │◄──────────────►│ FakeMC servers │      │ FakeMC servers │
│ Server discovery    │    HTTP/Auth   │ Port binding   │      │ Port binding   │
│ Control API (:3100) │◄──────────────►│ Rate limiting  │      │ Rate limiting  │
└─────────────────────┘                └────────────────┘      └────────────────┘
```

**Controller config** (panel VPS):
```json
{
  "mode": "controller",
  "controller": {
    "authToken": "your-secret-token"
  }
}
```

**Agent config** (each Wings node):
```json
{
  "mode": "agent",
  "agent": {
    "controllerUrl": "http://panel-ip:3100",
    "authToken": "your-secret-token",
    "nodeId": 1,
    "agentPort": 3200,
    "pollIntervalMs": 15000
  }
}
```

The `nodeId` is your Pterodactyl node ID (found in Admin → Nodes).

---

## MOTD States & Rotating Ads

Each state has its own MOTD. States with an `ads` array rotate ads on line 2 every refresh. States without `ads` show a static `line2`.

| State | Ads | Description |
|-------|-----|-------------|
| `offline` | ✅ Yes | Server is powered off |
| `suspended` | ✅ Yes | Server is suspended by admin |
| `installing` | ❌ No | Server is being installed |
| `starting` | ❌ No | Server is booting up |

```json
{
  "motd": {
    "offline": {
      "line1": "§7This server is currently offline. §8| §bYour Brand",
      "kickMessage": "§c§lServer Offline\n\n§7{SERVER_NAME} is currently offline.",
      "ads": [
        "§e§lAD: §fGet 10% off! §7Use code §aSAVE10",
        "§e§lAD: §fVisit §bexample.com §ffor premium hosting!"
      ]
    },
    "suspended": {
      "line1": "§4§l⛔ Server Suspended §8| §bYour Brand",
      "kickMessage": "§4§lServer Suspended\n\n§c{SERVER_NAME} has been suspended.",
      "ads": ["§e§lAD: §fVisit §bexample.com"]
    },
    "installing": {
      "line1": "§e§l⏳ Installing... §8| §bYour Brand",
      "line2": "§7{SERVER_NAME} is being set up. Please wait.",
      "kickMessage": "§e§lServer Installing\n\n§7Please check back soon."
    },
    "starting": {
      "line1": "§a§l▶ Starting... §8| §bYour Brand",
      "line2": "§7{SERVER_NAME} is booting up. Almost ready!",
      "kickMessage": "§a§lServer Starting\n\n§7Please wait a moment."
    }
  }
}
```

> **Note:** `{SERVER_NAME}` is replaced with each server's actual name.

### Server Icon

Must be a **64×64 pixel PNG** (max ~16KB). Larger images are skipped.

```json
{ "minecraft": { "icon": "./server-icon.png" } }
```

---

## IP Rate Limiting

Prevents connection spam. Default: 10 connections per IP per 60 seconds.

```json
{
  "rateLimit": {
    "maxConnections": 10,
    "windowMs": 60000
  }
}
```

---

## HTTP Control API

Runs on port `3100` (configurable). Accepts server names or UUIDs.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/power/:name/:signal` | ⭐ Release port + send power signal to Pterodactyl |
| `POST` | `/api/stop[/:name]` | Stop fake MC server(s) |
| `POST` | `/api/start[/:name]` | Start fake MC server(s) |
| `GET` | `/api/status[/:name]` | Get server status |
| `POST` | `/api/agent/register` | Agent registers with controller |
| `GET` | `/api/agent/servers?nodeId=N` | Agent polls for server list |
| `GET` | `/api/agent/list` | List connected agents |

### Power Signals: `start` | `stop` | `restart` | `kill`

```bash
# Start a server (release port + tell Pterodactyl to start)
curl -X POST http://localhost:3100/api/power/Survival/start

# Check all servers
curl http://localhost:3100/api/status
```

---

## Auto-Update

Pull the latest version from GitHub with one command:

```bash
node update.js
# or
npm run update
```

Automatically backs up and restores `config.json` and `server-icon.png` during updates.

---

## Pterodactyl Panel Modification

The included `pterodactyl/PowerButtons.tsx` modifies the panel's Start button to call OfflineMOTD first:

**User clicks Start → OfflineMOTD stops MOTD → releases port → starts real server via API**

### Installation

```bash
# 1. Replace the original file
cp pterodactyl/PowerButtons.tsx \
   /var/www/pterodactyl/resources/scripts/components/server/console/PowerButtons.tsx

# 2. Add nginx reverse proxy (required for HTTPS panels)
#    Add to your Pterodactyl nginx server{} block:
#
#    location /motd-api/ {
#        proxy_pass http://127.0.0.1:3100/;
#        proxy_set_header Host $host;
#        proxy_set_header X-Real-IP $remote_addr;
#    }
#
#    Then reload nginx: sudo nginx -t && sudo systemctl reload nginx

# 3. Rebuild the panel frontend
cd /var/www/pterodactyl
NODE_OPTIONS=--openssl-legacy-provider yarn build:production
```

If OfflineMOTD is unreachable, the Start button falls back to normal behavior.

---

## Running as a Service

### systemd

```ini
[Unit]
Description=OfflineMOTD
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/offlinemotd
ExecStart=/usr/bin/node index.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

### PM2

```bash
pm2 start index.js --name offlinemotd
pm2 save && pm2 startup
```

---

## Credits

- MC protocol based on [FakeMCServer](https://github.com/MrAdhit/FakeMCServer) by MrAdhit
- [Pterodactyl Panel](https://pterodactyl.io)
- Inspired by [AlwaysMOTD](https://builtbybit.com/resources/alwaysmotd-addon-pterodactyl.80177/) please support them too by buying their resource.

### Special Thanks

- 🧠 My brain — for the idea and the persistence to make it work
- 🤖 Claude Opus 4.6 — AI pair programmer that helped build this

## License

GPL-3.0
