/**
 * OfflineMOTD — Main Orchestrator
 * 
 * Auto-discovers ALL servers from the Pterodactyl Panel API.
 * No manual server configuration needed.
 * 
 * Flow:
 *   1. Connect to Pterodactyl API and list every server (with allocations/ports)
 *   2. For each offline/suspended server → start a fake MC server on its port
 *   3. For each online server → don't interfere
 *   4. Poll every 60s — automatically picks up new servers too
 *   5. POST /api/power/:name/start → stop MOTD → release port → tell Pterodactyl to start
 */

const fs = require('fs');
const path = require('path');
const log = require('./src/logger');
const FakeMCServer = require('./src/fakeMcServer');
const PterodactylPoller = require('./src/pterodactylPoller');
const ControlServer = require('./src/controlServer');

const TAG = 'Main';

// ─── Load Configuration ─────────────────────────────────────────────────────
function loadConfig() {
    const configPath = path.join(__dirname, 'config.json');

    if (!fs.existsSync(configPath)) {
        log.error(TAG, `config.json not found at ${configPath}`);
        log.info(TAG, 'Creating default config.json — please edit it with your Pterodactyl credentials!');

        const defaultConfig = {
            pterodactyl: {
                panelUrl: 'https://panel.example.com',
                apiKey: 'YOUR_APPLICATION_API_KEY',
                clientApiKey: 'YOUR_CLIENT_API_KEY',
                pollIntervalMs: 60000,
            },
            http: { port: 3100 },
            motd: {
                offline: {
                    line1: '§c§l⚠ {SERVER_NAME} — Offline',
                    line2: '§7Check back soon!',
                    maxPlayers: 0,
                    onlinePlayers: 0,
                    playerSample: [],
                    kickMessage: '§c§lServer Offline\n\n§7{SERVER_NAME} is currently offline.',
                },
                suspended: {
                    line1: '§4§l⛔ {SERVER_NAME} — Suspended',
                    line2: '§cContact an administrator',
                    maxPlayers: 0,
                    onlinePlayers: 0,
                    playerSample: [],
                    kickMessage: '§4§lServer Suspended\n\n§c{SERVER_NAME} has been suspended.',
                },
            },
            minecraft: {
                version: '1.21.5',
                protocol: 770,
                icon: './server-icon.png',
            },
        };

        fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2));
        return defaultConfig;
    }

    try {
        const raw = fs.readFileSync(configPath, 'utf-8');
        const config = JSON.parse(raw);
        log.success(TAG, 'Configuration loaded from config.json');
        return config;
    } catch (err) {
        log.error(TAG, `Failed to parse config.json: ${err.message}`);
        process.exit(1);
    }
}

// ─── Build MOTD config with server name substituted ─────────────────────────
function buildMotdForServer(motdTemplate, serverName) {
    const replaceName = (str) => {
        if (typeof str !== 'string') return str;
        return str.replace(/\{SERVER_NAME\}/g, serverName);
    };

    const result = {};
    for (const [state, motd] of Object.entries(motdTemplate)) {
        result[state] = {
            ...motd,
            line1: replaceName(motd.line1),
            line2: replaceName(motd.line2),
            kickMessage: replaceName(motd.kickMessage),
        };
    }
    return result;
}

// ─── Main Application ───────────────────────────────────────────────────────
async function main() {
    // Show ASCII art banner
    log.banner();

    // Load config
    const config = loadConfig();

    log.info(TAG, 'Mode: Auto-discovery (all servers from Pterodactyl Panel)');
    log.separator();

    // ─── Dynamic server instances ─────────────────────────────────────
    // Keyed by UUID: { [uuid]: { fakeMC, serverInfo, manualStop } }
    const instances = {};

    // ─── Called when poller discovers a new server ───────────────────
    function onServerDiscovered(serverInfo) {
        const key = serverInfo.uuid;
        if (instances[key]) return; // Already registered

        // Build MOTD with this server's name
        const motd = buildMotdForServer(config.motd || {}, serverInfo.name);

        const fakeMC = new FakeMCServer({
            minecraft: config.minecraft || {},
            motd: motd,
        });

        instances[key] = {
            fakeMC,
            serverInfo,
            manualStop: false,
        };

        log.server(TAG, `Registered: ${serverInfo.name} (${serverInfo.uuid}) → port ${serverInfo.port}`);
    }

    // ─── Handle per-server state changes ────────────────────────────────
    async function handleStateChange(uuid, newState, serverInfo) {
        const instance = instances[uuid];
        if (!instance) return;

        const { fakeMC } = instance;
        const name = serverInfo.name;
        const port = serverInfo.port;

        // Update server info (may have changed)
        instance.serverInfo = serverInfo;

        if (newState === 'online') {
            if (fakeMC.isRunning) {
                log.server(TAG, `[${name}] Real server ONLINE — stopping fake MC on port ${port}...`);
                await fakeMC.stop();
            }
        } else {
            // offline or suspended
            if (instance.manualStop) {
                log.debug(TAG, `[${name}] Skipping auto-start (manual stop active)`);
                instance.manualStop = false;
                return;
            }

            fakeMC.setState(newState);

            if (!fakeMC.isRunning) {
                log.server(TAG, `[${name}] ${newState.toUpperCase()} — starting fake MC on port ${port}...`);
                try {
                    await fakeMC.start(port);
                } catch (err) {
                    if (err.code === 'EADDRINUSE') {
                        log.warn(TAG, `[${name}] Port ${port} in use — will retry next poll`);
                    } else {
                        log.error(TAG, `[${name}] Failed to start: ${err.message}`);
                    }
                }
            }
        }
    }

    // ─── Initialize Pterodactyl Poller (auto-discovers everything) ──────
    const poller = new PterodactylPoller(
        config.pterodactyl,
        onServerDiscovered,
        handleStateChange
    );

    // ─── Helper: resolve server by UUID, identifier, or name ───────────
    function resolveServer(query) {
        // Direct UUID match
        if (instances[query]) {
            return { uuid: query, instance: instances[query] };
        }
        // Use poller's flexible search (identifier, name, partial UUID)
        const found = poller.findServer(query);
        if (found && instances[found.uuid]) {
            return { uuid: found.uuid, instance: instances[found.uuid] };
        }
        return null;
    }

    // ─── Initialize HTTP Control Server ─────────────────────────────────
    const controlServer = new ControlServer({
        // Stop one or all
        onStop: async (serverQuery) => {
            if (serverQuery) {
                const resolved = resolveServer(serverQuery);
                if (!resolved) throw new Error(`Server '${serverQuery}' not found`);
                resolved.instance.manualStop = true;
                await resolved.instance.fakeMC.stop();
            } else {
                for (const instance of Object.values(instances)) {
                    instance.manualStop = true;
                    await instance.fakeMC.stop();
                }
            }
        },

        // Start one or all
        onStart: async (serverQuery) => {
            if (serverQuery) {
                const resolved = resolveServer(serverQuery);
                if (!resolved) throw new Error(`Server '${serverQuery}' not found`);
                const inst = resolved.instance;
                inst.manualStop = false;
                const lastState = poller.getLastState(resolved.uuid);
                inst.fakeMC.setState(lastState === 'suspended' ? 'suspended' : 'offline');
                if (!inst.fakeMC.isRunning) {
                    await inst.fakeMC.start(inst.serverInfo.port);
                }
            } else {
                for (const [uuid, inst] of Object.entries(instances)) {
                    inst.manualStop = false;
                    const lastState = poller.getLastState(uuid);
                    inst.fakeMC.setState(lastState === 'suspended' ? 'suspended' : 'offline');
                    if (!inst.fakeMC.isRunning) {
                        try {
                            await inst.fakeMC.start(inst.serverInfo.port);
                        } catch (err) {
                            log.warn(TAG, `[${inst.serverInfo.name}] Could not start: ${err.message}`);
                        }
                    }
                }
            }
        },

        // Status
        getStatus: (serverQuery) => {
            if (serverQuery) {
                const resolved = resolveServer(serverQuery);
                if (!resolved) return { error: `Server '${serverQuery}' not found` };
                const inst = resolved.instance;
                return {
                    name: inst.serverInfo.name,
                    uuid: resolved.uuid,
                    identifier: inst.serverInfo.identifier,
                    motdActive: inst.fakeMC.isRunning,
                    currentMotdState: inst.fakeMC.currentState,
                    pterodactylState: poller.getLastState(resolved.uuid) || 'unknown',
                    port: inst.serverInfo.port,
                    ip: inst.serverInfo.ip,
                    suspended: inst.serverInfo.suspended,
                };
            }

            const allStatus = {};
            for (const [uuid, inst] of Object.entries(instances)) {
                allStatus[inst.serverInfo.name] = {
                    uuid: uuid,
                    identifier: inst.serverInfo.identifier,
                    motdActive: inst.fakeMC.isRunning,
                    currentMotdState: inst.fakeMC.currentState,
                    pterodactylState: poller.getLastState(uuid) || 'unknown',
                    port: inst.serverInfo.port,
                    ip: inst.serverInfo.ip,
                    suspended: inst.serverInfo.suspended,
                };
            }
            return {
                servers: allStatus,
                totalServers: Object.keys(instances).length,
                uptime: process.uptime(),
                controlPort: config.http?.port,
            };
        },

        // Power control: stop MOTD → release port → send signal to Pterodactyl
        onPower: async (serverQuery, signal) => {
            const resolved = resolveServer(serverQuery);
            if (!resolved) throw new Error(`Server '${serverQuery}' not found`);

            const inst = resolved.instance;
            const name = inst.serverInfo.name;

            // Step 1: Stop fake MC to release the port
            inst.manualStop = true;
            if (inst.fakeMC.isRunning) {
                await inst.fakeMC.stop();
                log.info(TAG, `[${name}] Port ${inst.serverInfo.port} released`);
            }

            // Step 2: Brief delay for port release
            await new Promise(r => setTimeout(r, 1000));

            // Step 3: Send power signal to Pterodactyl
            log.info(TAG, `[${name}] Sending '${signal}' to Pterodactyl...`);
            await poller.sendPowerSignal(resolved.uuid, signal);

            return {
                server: name,
                uuid: resolved.uuid,
                signal,
                portReleased: true,
                pterodactylSignalSent: true,
            };
        },
    });

    // ─── Start everything ───────────────────────────────────────────────
    try {
        await controlServer.start(config.http?.port || 3100);
        log.separator();
        await poller.startPolling();
        log.separator();
        log.success(TAG, 'OfflineMOTD is fully operational!');
        log.info(TAG, 'All servers are auto-discovered from Pterodactyl. No manual config needed.');
        log.separator();
    } catch (err) {
        log.error(TAG, `Startup failed: ${err.message}`);
        process.exit(1);
    }

    // ─── Graceful shutdown ──────────────────────────────────────────────
    async function shutdown(signal) {
        log.info(TAG, `Received ${signal} — shutting down...`);
        poller.stopPolling();
        for (const inst of Object.values(instances)) {
            await inst.fakeMC.stop();
        }
        await controlServer.stop();
        log.info(TAG, 'Goodbye!');
        process.exit(0);
    }

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// Run
main().catch((err) => {
    log.error(TAG, `Fatal error: ${err.message}`);
    console.error(err);
    process.exit(1);
});
