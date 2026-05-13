/**
 * OfflineMOTD — Main Orchestrator
 *
 * Supports three modes:
 *   - standalone: Everything in one process (default, single node)
 *   - controller: Discovers servers, delegates to agents (panel VPS)
 *   - agent:      Polls controller, manages local FakeMC instances (Wings nodes)
 *
 * Flow (standalone):
 *   1. Connect to Pterodactyl API and list every server (with allocations/ports)
 *   2. For each offline/suspended server → start a fake MC server on its port
 *   3. For each online server → don't interfere
 *   4. Poll every 60s — automatically picks up new servers too
 *   5. POST /api/power/:name/start → stop MOTD → release port → tell Pterodactyl to start
 *
 * Flow (controller + agent):
 *   Controller discovers servers, agents poll for their node's servers.
 *   Power control goes: Panel → Controller → Agent (release port) → Pterodactyl (start)
 */

const fs = require('fs');
const path = require('path');
const log = require('./src/logger');
const FakeMCServer = require('./src/fakeMcServer');
const PterodactylPoller = require('./src/pterodactylPoller');
const ControlServer = require('./src/controlServer');
const AgentClient = require('./src/agentClient');

const TAG = 'Main';

// ─── Load Configuration ─────────────────────────────────────────────────────
function loadConfig() {
    const configPath = path.join(__dirname, 'config.json');

    if (!fs.existsSync(configPath)) {
        log.error(TAG, `config.json not found at ${configPath}`);
        log.info(TAG, 'Creating default config.json — please edit it with your Pterodactyl credentials!');

        const defaultConfig = {
            mode: 'standalone',
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
            ads: (motd.ads || []).map(replaceName),
        };
    }
    return result;
}

// ═══════════════════════════════════════════════════════════════════════════
//  STANDALONE MODE — Everything in one process (original behavior)
// ═══════════════════════════════════════════════════════════════════════════

async function runStandalone(config) {
    log.info(TAG, 'Mode: Standalone (all servers from Pterodactyl Panel)');
    log.separator();

    // ─── Dynamic server instances ─────────────────────────────────────
    const instances = {};

    function onServerDiscovered(serverInfo) {
        const key = serverInfo.uuid;
        if (instances[key]) return;

        const motd = buildMotdForServer(config.motd || {}, serverInfo.name);
        const fakeMC = new FakeMCServer({
            minecraft: config.minecraft || {},
            motd: motd,
            rateLimit: config.rateLimit || {},
        });

        instances[key] = { fakeMC, serverInfo, manualStop: false };
        log.server(TAG, `Registered: ${serverInfo.name} (${serverInfo.uuid}) → port ${serverInfo.port}`);
    }

    async function handleStateChange(uuid, newState, serverInfo) {
        const instance = instances[uuid];
        if (!instance) return;

        const { fakeMC } = instance;
        const name = serverInfo.name;
        const port = serverInfo.port;
        instance.serverInfo = serverInfo;

        if (newState === 'online') {
            if (fakeMC.isRunning) {
                log.server(TAG, `[${name}] Real server ONLINE — stopping fake MC on port ${port}...`);
                await fakeMC.stop();
            }
        } else {
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

    const poller = new PterodactylPoller(config.pterodactyl, onServerDiscovered, handleStateChange);

    function resolveServer(query) {
        if (instances[query]) return { uuid: query, instance: instances[query] };
        const found = poller.findServer(query);
        if (found && instances[found.uuid]) return { uuid: found.uuid, instance: instances[found.uuid] };
        return null;
    }

    const controlServer = new ControlServer({
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
        onStart: async (serverQuery) => {
            if (serverQuery) {
                const resolved = resolveServer(serverQuery);
                if (!resolved) throw new Error(`Server '${serverQuery}' not found`);
                const inst = resolved.instance;
                inst.manualStop = false;
                const lastState = poller.getLastState(resolved.uuid);
                inst.fakeMC.setState(lastState === 'suspended' ? 'suspended' : 'offline');
                if (!inst.fakeMC.isRunning) await inst.fakeMC.start(inst.serverInfo.port);
            } else {
                for (const [uuid, inst] of Object.entries(instances)) {
                    inst.manualStop = false;
                    const lastState = poller.getLastState(uuid);
                    inst.fakeMC.setState(lastState === 'suspended' ? 'suspended' : 'offline');
                    if (!inst.fakeMC.isRunning) {
                        try { await inst.fakeMC.start(inst.serverInfo.port); }
                        catch (err) { log.warn(TAG, `[${inst.serverInfo.name}] Could not start: ${err.message}`); }
                    }
                }
            }
        },
        getStatus: (serverQuery) => {
            if (serverQuery) {
                const resolved = resolveServer(serverQuery);
                if (!resolved) return { error: `Server '${serverQuery}' not found` };
                const inst = resolved.instance;
                return {
                    name: inst.serverInfo.name, uuid: resolved.uuid,
                    identifier: inst.serverInfo.identifier,
                    motdActive: inst.fakeMC.isRunning, currentMotdState: inst.fakeMC.currentState,
                    pterodactylState: poller.getLastState(resolved.uuid) || 'unknown',
                    port: inst.serverInfo.port, ip: inst.serverInfo.ip,
                    suspended: inst.serverInfo.suspended,
                };
            }
            const allStatus = {};
            for (const [uuid, inst] of Object.entries(instances)) {
                allStatus[inst.serverInfo.name] = {
                    uuid, identifier: inst.serverInfo.identifier,
                    motdActive: inst.fakeMC.isRunning, currentMotdState: inst.fakeMC.currentState,
                    pterodactylState: poller.getLastState(uuid) || 'unknown',
                    port: inst.serverInfo.port, ip: inst.serverInfo.ip,
                    suspended: inst.serverInfo.suspended,
                };
            }
            return { servers: allStatus, totalServers: Object.keys(instances).length, uptime: process.uptime(), mode: 'standalone' };
        },
        onPower: async (serverQuery, signal) => {
            const resolved = resolveServer(serverQuery);
            if (!resolved) throw new Error(`Server '${serverQuery}' not found`);
            const inst = resolved.instance;
            const name = inst.serverInfo.name;
            inst.manualStop = true;
            if (inst.fakeMC.isRunning) {
                await inst.fakeMC.stop();
                log.info(TAG, `[${name}] Port ${inst.serverInfo.port} released`);
            }
            await new Promise(r => setTimeout(r, 1000));
            log.info(TAG, `[${name}] Sending '${signal}' to Pterodactyl...`);
            await poller.sendPowerSignal(resolved.uuid, signal);
            return { server: name, uuid: resolved.uuid, signal, portReleased: true, pterodactylSignalSent: true };
        },
    });

    await controlServer.start(config.http?.port || 3100);
    log.separator();
    await poller.startPolling();
    log.separator();
    log.success(TAG, 'OfflineMOTD is fully operational! (standalone mode)');
    log.info(TAG, 'All servers are auto-discovered from Pterodactyl. No manual config needed.');
    log.separator();

    return { poller, controlServer, instances };
}

// ═══════════════════════════════════════════════════════════════════════════
//  CONTROLLER MODE — Discovers servers, delegates to agents
// ═══════════════════════════════════════════════════════════════════════════

async function runController(config) {
    log.info(TAG, 'Mode: Controller (delegates to agents on Wings nodes)');
    log.separator();

    const controllerConfig = config.controller || {};

    // Track all server states
    const serverStates = {}; // uuid → state
    const allServers = {};   // uuid → serverInfo

    function onServerDiscovered(serverInfo) {
        allServers[serverInfo.uuid] = serverInfo;
        log.server(TAG, `Registered: ${serverInfo.name} (node ${serverInfo.node}) → port ${serverInfo.port}`);
    }

    async function handleStateChange(uuid, newState, serverInfo) {
        serverStates[uuid] = newState;
        allServers[uuid] = serverInfo;
        log.api(TAG, `[${serverInfo.name}] State: ${newState.toUpperCase()} (node ${serverInfo.node})`);
    }

    const poller = new PterodactylPoller(config.pterodactyl, onServerDiscovered, handleStateChange);

    function resolveServer(query) {
        if (allServers[query]) return { uuid: query, server: allServers[query] };
        const found = poller.findServer(query);
        if (found) return { uuid: found.uuid, server: found.server };
        return null;
    }

    const controlServer = new ControlServer({
        onStop: async () => { log.warn(TAG, 'Stop not supported in controller mode — use agents'); },
        onStart: async () => { log.warn(TAG, 'Start not supported in controller mode — use agents'); },

        getStatus: (serverQuery) => {
            if (serverQuery) {
                const resolved = resolveServer(serverQuery);
                if (!resolved) return { error: `Server '${serverQuery}' not found` };
                return {
                    name: resolved.server.name, uuid: resolved.uuid,
                    node: resolved.server.node, port: resolved.server.port,
                    state: serverStates[resolved.uuid] || 'unknown',
                    suspended: resolved.server.suspended,
                };
            }
            const allStatus = {};
            for (const [uuid, srv] of Object.entries(allServers)) {
                allStatus[srv.name] = {
                    uuid, node: srv.node, port: srv.port,
                    state: serverStates[uuid] || 'unknown',
                    suspended: srv.suspended,
                };
            }
            return {
                servers: allStatus,
                totalServers: Object.keys(allServers).length,
                agents: controlServer._agents,
                uptime: process.uptime(),
                mode: 'controller',
            };
        },

        // Power: tell agent to release port, then send signal to Pterodactyl
        onPower: async (serverQuery, signal) => {
            const resolved = resolveServer(serverQuery);
            if (!resolved) throw new Error(`Server '${serverQuery}' not found`);
            const srv = resolved.server;

            // Step 1: Tell agent to release the port
            if (srv.node) {
                await controlServer.releaseOnAgent(srv.node, resolved.uuid);
            }

            // Step 2: Brief delay
            await new Promise(r => setTimeout(r, 1000));

            // Step 3: Send power signal to Pterodactyl
            log.info(TAG, `[${srv.name}] Sending '${signal}' to Pterodactyl...`);
            await poller.sendPowerSignal(resolved.uuid, signal);

            return {
                server: srv.name, uuid: resolved.uuid,
                node: srv.node, signal,
                portReleased: true, pterodactylSignalSent: true,
            };
        },

        // Agent handler: return servers for a specific node
        getServersForNode: (nodeId) => {
            const servers = [];
            for (const [uuid, srv] of Object.entries(allServers)) {
                if (srv.node === nodeId) {
                    const state = serverStates[uuid] || 'offline';
                    const motd = buildMotdForServer(config.motd || {}, srv.name);
                    servers.push({
                        uuid, name: srv.name, port: srv.port,
                        state, suspended: srv.suspended,
                        motd,
                    });
                }
            }
            return servers;
        },
    }, controllerConfig);

    await controlServer.start(config.http?.port || 3100);
    log.separator();
    await poller.startPolling();
    log.separator();
    log.success(TAG, 'OfflineMOTD Controller is operational!');
    log.info(TAG, 'Waiting for agents to connect...');
    log.separator();

    return { poller, controlServer };
}

// ═══════════════════════════════════════════════════════════════════════════
//  AGENT MODE — Polls controller, manages local FakeMC instances
// ═══════════════════════════════════════════════════════════════════════════

async function runAgent(config) {
    const agentConfig = config.agent || {};
    log.info(TAG, 'Mode: Agent (managed by controller)');
    log.info(TAG, `  Controller: ${agentConfig.controllerUrl}`);
    log.info(TAG, `  Node ID:    ${agentConfig.nodeId}`);
    log.separator();

    const agent = new AgentClient(agentConfig, config);
    await agent.start();

    log.separator();
    log.success(TAG, 'OfflineMOTD Agent is operational!');
    log.separator();

    return { agent };
}

// ═══════════════════════════════════════════════════════════════════════════
//  MAIN
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
    log.banner();
    const config = loadConfig();
    const mode = config.mode || 'standalone';

    let context;

    if (mode === 'controller') {
        context = await runController(config);
    } else if (mode === 'agent') {
        context = await runAgent(config);
    } else {
        context = await runStandalone(config);
    }

    // ─── Graceful shutdown ──────────────────────────────────────────────
    async function shutdown(signal) {
        log.info(TAG, `Received ${signal} — shutting down...`);

        if (context.poller) context.poller.stopPolling();
        if (context.controlServer) await context.controlServer.stop();
        if (context.agent) await context.agent.stop();

        if (context.instances) {
            for (const inst of Object.values(context.instances)) {
                await inst.fakeMC.stop();
            }
        }

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
