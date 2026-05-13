# OfflineMOTD

**Pterodactyl-aware fake Minecraft MOTD server** — automatically discovers ALL your servers from the Pterodactyl Panel API. When a server is offline or suspended, it shows a custom MOTD with **rotating ads** on that port. When the server starts, it releases the port seamlessly.

**Zero server configuration needed** — just provide your Pterodactyl API keys and it handles everything.

---

## Features

- 🔍 **Auto-Discovery** — Fetches ALL servers from Pterodactyl automatically (with pagination)
- 🎯 **Dynamic MOTD** — Different messages for offline vs. suspended, with server name injected
- 📢 **Rotating Ads** — Cycle through multiple ads on line 2 of the MOTD (each refresh shows the next ad)
- 🖥️ **Multi-Server** — Monitors every server on your panel simultaneously
- ⚡ **Power Control** — Start/stop real servers via API (stops MOTD → releases port → tells Pterodactyl)
- 🔄 **Seamless Port Handoff** — No "port already in use" errors
- 📦 **Zero Dependencies** — Pure Node.js, no `npm install` needed
- 🔁 **Auto-Refresh** — Picks up new servers added to the panel automatically

---

## Quick Start

### 1. Install Node.js 18+

### 2. Configure

Edit `config.json` — you only need your Pterodactyl credentials:

```json
{
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
[12:00:00] [OK]     [Pterodactyl] Discovered: Skyblock (ID: 3) — Port 25567
[12:00:00] [INFO]   [Pterodactyl] Total servers: 3 (3 new)
[12:00:01] [API]    [Pterodactyl] [Survival] INIT → OFFLINE
[12:00:01] [SERVER] [Main] [Survival] OFFLINE — starting fake MC on port 25565...
```

---

## How It Works

1. **Startup** → Calls `GET /api/application/servers?include=allocations` to find ALL servers + their ports
2. **Per server**: checks if offline/suspended → starts fake MC on that port with custom MOTD
3. **Online servers** → no fake MC (real server has the port)
4. **Every 60s** → re-polls all servers, picks up new ones, handles state changes
5. **Power control** → `POST /api/power/Survival/start` releases port + starts real server

---

## MOTD Configuration & Rotating Ads

Each state (offline/suspended) has its own MOTD line 1, kick message, and a list of **rotating ads** for line 2. Every time a player refreshes their server list, they see the next ad.

```json
{
  "motd": {
    "offline": {
      "line1": "§7This server is currently offline. §8| §bYour Brand",
      "maxPlayers": 0,
      "onlinePlayers": 0,
      "kickMessage": "§c§lServer Offline\n\n§7{SERVER_NAME} is currently offline.",
      "ads": [
        "§e§lAD: §fGet 10% off on your first order! §7Use code §aSAVE10",
        "§e§lAD: §fVisit §bexample.com §ffor premium hosting!",
        "§e§lAD: §fNeed more RAM? Upgrade today at §bexample.com/plans"
      ]
    },
    "suspended": {
      "line1": "§4§l⛔ Server Suspended §8| §bYour Brand",
      "kickMessage": "§4§lServer Suspended\n\n§c{SERVER_NAME} has been suspended.",
      "ads": [
        "§e§lAD: §fVisit §bexample.com §ffor premium hosting!"
      ]
    }
  }
}
```

**Result in Minecraft server list:**
```
Line 1: §7This server is currently offline. | Your Brand
Line 2: §e§lAD: §fGet 10% off on your first order! §7Use code §aSAVE10   ← rotates each refresh
```

> **Note:** If `ads` is empty or missing, a static `line2` field is used as fallback.

### Server Icon

The server icon must be a **64×64 pixel PNG** file (max ~16KB). Larger images will be skipped to avoid protocol issues.

```json
{
  "minecraft": {
    "version": "1.21.5",
    "protocol": 770,
    "icon": "./server-icon.png"
  }
}
```

---

## HTTP Control API

Runs on port `3100` (configurable). Accepts server names or UUIDs.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/power/:name/:signal` | ⭐ Release port + send power signal to Pterodactyl |
| `POST` | `/api/stop` | Stop ALL fake MC servers |
| `POST` | `/api/stop/:name` | Stop a specific server's MOTD |
| `POST` | `/api/start` | Start ALL fake MC servers |
| `POST` | `/api/start/:name` | Start a specific server's MOTD |
| `GET` | `/api/status` | Status of all servers |
| `GET` | `/api/status/:name` | Status of a specific server |

### Power Signals: `start` | `stop` | `restart` | `kill`

### Examples

```bash
# Start a server (release port + tell Pterodactyl to start)
curl -X POST http://localhost:3100/api/power/Survival/start

# Check all servers
curl http://localhost:3100/api/status

# Check one server
curl http://localhost:3100/api/status/Survival
```

---

## Pterodactyl Panel Modification

The included `pterodactyl/PowerButtons.tsx` modifies the panel's Start button so it calls OfflineMOTD first:

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
WorkingDirectory=/opt/alwaysmotd
ExecStart=/usr/bin/node index.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

### PM2

```bash
pm2 start index.js --name alwaysmotd
pm2 save && pm2 startup
```

---

## Credits

- MC protocol based on [FakeMCServer](https://github.com/MrAdhit/FakeMCServer) by MrAdhit
- [Pterodactyl Panel](https://pterodactyl.io)

### Special Thanks

- 🧠 My brain — for the idea and the persistence to make it work
- 🤖 Claude Opus 4.6 — AI pair programmer that helped build this

## License

GPL-3.0
