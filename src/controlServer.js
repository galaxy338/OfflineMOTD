/**
 * OfflineMOTD — HTTP Control Server
 * 
 * Exposes a simple HTTP API to control fake Minecraft servers.
 * Supports multi-server: stop/start individual servers by name or all at once.
 * Also provides a power management endpoint to control Pterodactyl servers.
 * 
 * Endpoints:
 *   POST /api/stop              — Stop ALL fake MC servers
 *   POST /api/stop/:name        — Stop a specific server by name
 *   POST /api/start             — Start ALL fake MC servers
 *   POST /api/start/:name       — Start a specific server by name
 *   POST /api/power/:name/:signal — Stop fake MC + send power signal (start/stop/restart/kill) to Pterodactyl
 *   GET  /api/status            — Get status of all servers
 *   GET  /api/status/:name      — Get status of a specific server
 *
 * Agent endpoints (controller mode):
 *   POST /api/agent/register    — Agent registers itself
 *   GET  /api/agent/servers     — Agent polls for its server list
 */

const http = require('http');
const https = require('https');
const log = require('./logger');

const TAG = 'Control';

class ControlServer {
    /**
     * @param {object} handlers
     * @param {function} handlers.onStop - async (serverName?: string) => void
     * @param {function} handlers.onStart - async (serverName?: string) => void
     * @param {function} handlers.onPower - async (serverName: string, signal: string) => object — stop fake MC, send power signal
     * @param {function} handlers.getStatus - (serverName?: string) => object
     */
    constructor(handlers, controllerConfig = {}) {
        this.handlers = handlers;
        this.server = null;
        this.authToken = controllerConfig.authToken || '';

        // Agent registry: { [nodeId]: { nodeId, ip, agentPort, lastSeen } }
        this._agents = {};
    }

    /**
     * Parse URL path segments: /api/action/name → ['api', 'action', 'name']
     */
    _parsePath(url) {
        const path = (url || '').split('?')[0];
        return path.split('/').filter(Boolean);
    }

    /**
     * Send JSON response
     */
    _sendJson(res, statusCode, data) {
        res.writeHead(statusCode, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
        });
        res.end(JSON.stringify(data, null, 2));
    }

    /**
     * Start the HTTP control server
     */
    start(port) {
        return new Promise((resolve, reject) => {
            this.server = http.createServer(async (req, res) => {
                if (req.method === 'OPTIONS') {
                    this._sendJson(res, 204, {});
                    return;
                }

                const segments = this._parsePath(req.url);
                // segments: ['api', 'action', 'name', 'extra']
                const action = segments[1] || '';
                const name = decodeURIComponent(segments[2] || '');
                const extra = decodeURIComponent(segments[3] || '');

                try {
                    // ─── GET /api/status[/:name] ────────────────────────
                    if (req.method === 'GET' && action === 'status') {
                        const status = this.handlers.getStatus(name || null);
                        this._sendJson(res, 200, status);
                        return;
                    }

                    // ─── POST /api/power/:name/:signal ──────────────────
                    // Flow: stop fake MC → release port → send power signal to Pterodactyl
                    if (req.method === 'POST' && action === 'power' && name) {
                        const signal = extra || 'start';
                        log.info(TAG, `Power request: ${name} → ${signal}`);
                        log.info(TAG, `  Step 1: Stopping fake MC for '${name}' to release port...`);
                        const result = await this.handlers.onPower(name, signal);
                        this._sendJson(res, 200, {
                            success: true,
                            message: `Port released, power signal '${signal}' sent to '${name}'`,
                            ...result,
                        });
                        return;
                    }

                    // ─── POST /api/agent/register ───────────────────────
                    if (req.method === 'POST' && action === 'agent' && name === 'register') {
                        let body = '';
                        req.on('data', (chunk) => (body += chunk));
                        await new Promise((r) => req.on('end', r));

                        try {
                            const data = JSON.parse(body);
                            const agentIp = req.socket.remoteAddress || 'unknown';
                            const nodeId = data.nodeId;
                            const agentPort = data.agentPort || 3200;

                            if (!nodeId) {
                                this._sendJson(res, 400, { error: 'nodeId is required' });
                                return;
                            }

                            // Validate auth token if set
                            if (this.authToken) {
                                const reqToken = (req.headers.authorization || '').replace('Bearer ', '');
                                if (reqToken !== this.authToken) {
                                    this._sendJson(res, 401, { error: 'Invalid auth token' });
                                    return;
                                }
                            }

                            this._agents[nodeId] = {
                                nodeId,
                                ip: agentIp.replace('::ffff:', ''),
                                agentPort,
                                lastSeen: Date.now(),
                            };

                            log.success(TAG, `Agent registered: Node ${nodeId} at ${agentIp}:${agentPort}`);
                            this._sendJson(res, 200, { ok: true });
                        } catch (err) {
                            this._sendJson(res, 400, { error: 'Invalid JSON body' });
                        }
                        return;
                    }

                    // ─── GET /api/agent/servers?nodeId=N ─────────────────
                    if (req.method === 'GET' && action === 'agent' && name === 'servers') {
                        // Validate auth token if set
                        if (this.authToken) {
                            const reqToken = (req.headers.authorization || '').replace('Bearer ', '');
                            if (reqToken !== this.authToken) {
                                this._sendJson(res, 401, { error: 'Invalid auth token' });
                                return;
                            }
                        }

                        // Parse nodeId from query string
                        const urlObj = new URL(req.url, `http://${req.headers.host}`);
                        const nodeIdStr = urlObj.searchParams.get('nodeId') || extra;
                        const nodeId = parseInt(nodeIdStr, 10);

                        if (!nodeId) {
                            this._sendJson(res, 400, { error: 'nodeId is required' });
                            return;
                        }

                        // Update agent last seen
                        if (this._agents[nodeId]) {
                            this._agents[nodeId].lastSeen = Date.now();
                        }

                        // Get servers for this node via handler
                        const servers = this.handlers.getServersForNode
                            ? this.handlers.getServersForNode(nodeId)
                            : [];
                        this._sendJson(res, 200, { servers });
                        return;
                    }

                    // ─── GET /api/agent/list ─────────────────────────────
                    if (req.method === 'GET' && action === 'agent' && name === 'list') {
                        this._sendJson(res, 200, {
                            agents: Object.values(this._agents),
                        });
                        return;
                    }

                    // ─── 404 ────────────────────────────────────────────
                    this._sendJson(res, 404, {
                        error: 'Not found',
                        endpoints: [
                            'POST /api/power/:serverName/:signal  (signal: start|stop|restart|kill)',
                            'GET  /api/status[/:serverName]',
                            'POST /api/agent/register             (agent mode)',
                            'GET  /api/agent/servers?nodeId=N     (agent mode)',
                            'GET  /api/agent/list                 (list agents)',
                        ],
                    });
                } catch (err) {
                    log.error(TAG, `Request error: ${err.message}`);
                    this._sendJson(res, 500, { error: err.message });
                }
            });

            this.server.on('error', (err) => {
                log.error(TAG, `Control server error: ${err.message}`);
                reject(err);
            });

            this.server.listen(port, () => {
                log.success(TAG, `HTTP control API listening on port ${port}`);
                log.info(TAG, `  POST /api/stop[/:name]          — Stop fake MC server(s)`);
                log.info(TAG, `  POST /api/start[/:name]         — Start fake MC server(s)`);
                log.info(TAG, `  POST /api/power/:name/:signal   — Release port + Pterodactyl power`);
                log.info(TAG, `  GET  /api/status[/:name]        — Get current status`);
                resolve();
            });
        });
    }

    /**
     * Stop the HTTP control server
     */
    stop() {
        return new Promise((resolve) => {
            if (this.server) {
                this.server.close(() => {
                    log.info(TAG, 'Control server stopped');
                    resolve();
                });
            } else {
                resolve();
            }
        });
    }

    /**
     * Get an agent's connection info by node ID
     */
    getAgent(nodeId) {
        return this._agents[nodeId] || null;
    }

    /**
     * Tell an agent to release a specific server's port
     */
    async releaseOnAgent(nodeId, uuid) {
        const agent = this._agents[nodeId];
        if (!agent) {
            log.warn(TAG, `No agent registered for node ${nodeId}`);
            return false;
        }

        const url = `http://${agent.ip}:${agent.agentPort}/agent/release/${encodeURIComponent(uuid)}`;
        log.info(TAG, `Telling agent (node ${nodeId}) to release ${uuid}...`);

        return new Promise((resolve) => {
            const transport = http;
            const req = transport.request(url, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.authToken}`,
                    'Content-Type': 'application/json',
                },
            }, (res) => {
                let body = '';
                res.on('data', (c) => (body += c));
                res.on('end', () => {
                    try {
                        const data = JSON.parse(body);
                        log.success(TAG, `Agent (node ${nodeId}) responded: released=${data.released}`);
                        resolve(true);
                    } catch {
                        resolve(false);
                    }
                });
            });
            req.on('error', (err) => {
                log.error(TAG, `Failed to reach agent (node ${nodeId}): ${err.message}`);
                resolve(false);
            });
            req.setTimeout(5000, () => req.destroy());
            req.end();
        });
    }
}

module.exports = ControlServer;
