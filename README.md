# AlwaysMOTD

**Pterodactyl-aware fake Minecraft MOTD server** — automatically discovers ALL your servers from the Pterodactyl Panel API. When a server is offline or suspended, it shows a custom MOTD on that port. When the server starts, it releases the port seamlessly.

**Zero server configuration needed** — just provide your Pterodactyl API keys and it handles everything.

---

## Features

- 🔍 **Auto-Discovery** — Fetches ALL servers from Pterodactyl automatically (with pagination)
- 🎯 **Dynamic MOTD** — Different messages for offline vs. suspended, with server name injected
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

That's it. No server list needed — AlwaysMOTD discovers everything automatically.

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

## HTTP Control API

Runs on port `3100` (configurable). Server names are case-insensitive.

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

## MOTD Templates

The MOTD uses `{SERVER_NAME}` as a placeholder that gets replaced with each server's actual name:

```json
{
  "motd": {
    "offline": {
      "line1": "§c§l⚠ {SERVER_NAME} — Offline",
      "line2": "§7Check back soon!",
      "kickMessage": "§c§lServer Offline\n\n§7{SERVER_NAME} is currently offline."
    },
    "suspended": {
      "line1": "§4§l⛔ {SERVER_NAME} — Suspended",
      "line2": "§cContact an administrator",
      "kickMessage": "§4§lServer Suspended\n\n§c{SERVER_NAME} has been suspended."
    }
  }
}
```

---

## Pterodactyl Panel Modification

The included `pterodactyl/PowerButtons.tsx` modifies the panel's Start button so it calls AlwaysMOTD first:

**User clicks Start → AlwaysMOTD stops MOTD → releases port → starts real server via API**

### Installation

```bash
# 1. Replace the original file
cp pterodactyl/PowerButtons.tsx \
   /var/www/pterodactyl/resources/scripts/components/server/console/PowerButtons.tsx

# 2. Edit ALWAYSMOTD_URL in the file (line 38)
#    const ALWAYSMOTD_URL = 'http://YOUR_ALWAYSMOTD_IP:3100';

# 3. Rebuild the panel frontend
cd /var/www/pterodactyl
yarn install
yarn build:production
```

If AlwaysMOTD is unreachable, the Start button falls back to normal behavior.

---

## Running as a Service

### systemd

```ini
[Unit]
Description=AlwaysMOTD
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

## License

GPL-3.0
