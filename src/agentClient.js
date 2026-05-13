/**
 * OfflineMOTD — Agent Client
 *
 * Runs on each Wings node. Connects to the controller (panel VPS),
 * polls for its assigned server list, and manages FakeMC instances locally.
 *
 * The agent:
 *   1. Registers with the controller (nodeId + agentPort)
 *   2. Polls for its server list + states
 *   3. Creates/destroys FakeMCServer instances based on controller data
 *   4. Exposes a local HTTP endpoint for the controller to release ports
 */

const http = require('http');
const https = require('https');
const log = require('./logger');
const FakeMCServer = require('./fakeMcServer');

const TAG = 'Agent';

class AgentClient {
    /**
     * @param {object} agentConfig - { controllerUrl, authToken, nodeId, pollIntervalMs }
     * @param {object} fullConfig - full config (for minecraft, motd, rateLimit settings)
     */
    constructor(agentConfig, fullConfig) {
        this.controllerUrl = (agentConfig.controllerUrl || '').replace(/\/+$/, '');
        this.authToken = agentConfig.authToken || '';
        this.nodeId = agentConfig.nodeId;
        this.pollInterval = agentConfig.pollIntervalMs || 15000;
        this.agentPort = agentConfig.agentPort || 3200;
        this.fullConfig = fullConfig;

        this._timer = null;
        this._isPolling = false;
        this._httpServer = null;

        // Active FakeMC instances keyed by UUID
        this._instances = {};
    }

    // ─── HTTP Request Helper ────────────────────────────────────────────

    _request(method, urlStr, body = null) {
        return new Promise((resolve, reject) => {
            const urlObj = new URL(urlStr);
            const transport = urlObj.protocol === 'https:' ? https : http;

            const options = {
                hostname: urlObj.hostname,
                port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
                path: urlObj.pathname + urlObj.search,
                method,
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.authToken}`,
                },
                rejectUnauthorized: false,
            };

            const bodyStr = body ? JSON.stringify(body) : null;
            if (bodyStr) {
                options.headers['Content-Length'] = Buffer.byteLength(bodyStr);
            }

            const req = transport.request(options, (res) => {
                let data = '';
                res.on('data', (chunk) => (data += chunk));
                res.on('end', () => {
                    try {
                        resolve({ status: res.statusCode, data: data ? JSON.parse(data) : null });
                    } catch {
                        resolve({ status: res.statusCode, data: null });
                    }
                });
            });

            req.on('error', reject);
            req.setTimeout(10000, () => req.destroy(new Error('Request timed out')));
            if (bodyStr) req.write(bodyStr);
            req.end();
        });
    }

    // ─── Registration ───────────────────────────────────────────────────

    async register() {
        log.info(TAG, `Registering with controller at ${this.controllerUrl}...`);
        log.info(TAG, `  Node ID: ${this.nodeId}, Agent port: ${this.agentPort}`);

        try {
            const res = await this._request('POST', `${this.controllerUrl}/api/agent/register`, {
                nodeId: this.nodeId,
                agentPort: this.agentPort,
            });

            if (res.status === 200 && res.data?.ok) {
                log.success(TAG, 'Registered with controller');
                return true;
            } else {
                log.error(TAG, `Registration failed: ${JSON.stringify(res.data)}`);
                return false;
            }
        } catch (err) {
            log.error(TAG, `Cannot reach controller: ${err.message}`);
            return false;
        }
    }

    // ─── Polling ────────────────────────────────────────────────────────

    async _poll() {
        if (this._isPolling) return;
        this._isPolling = true;

        try {
            const res = await this._request(
                'GET',
                `${this.controllerUrl}/api/agent/servers?nodeId=${this.nodeId}`
            );

            if (res.status !== 200 || !res.data?.servers) {
                log.warn(TAG, `Failed to get server list from controller (HTTP ${res.status})`);
                return;
            }

            const serverList = res.data.servers;
            const activeUuids = new Set();

            for (const srv of serverList) {
                activeUuids.add(srv.uuid);
                await this._syncServer(srv);
            }

            // Stop instances for servers no longer in the list
            for (const uuid of Object.keys(this._instances)) {
                if (!activeUuids.has(uuid)) {
                    log.info(TAG, `[${this._instances[uuid].name}] Removed from assignment — stopping`);
                    await this._instances[uuid].fakeMC.stop();
                    delete this._instances[uuid];
                }
            }
        } catch (err) {
            log.warn(TAG, `Poll error: ${err.message}`);
        } finally {
            this._isPolling = false;
        }
    }

    /**
     * Sync a single server: start/stop/update FakeMC based on controller state
     */
    async _syncServer(srv) {
        const { uuid, name, port, state, motd } = srv;

        if (state === 'online') {
            // Server is online — stop FakeMC if running
            if (this._instances[uuid]?.fakeMC?.isRunning) {
                log.server(TAG, `[${name}] Online — stopping fake MC on port ${port}`);
                await this._instances[uuid].fakeMC.stop();
            }
            return;
        }

        // Server is offline or suspended — start FakeMC
        if (!this._instances[uuid]) {
            const fakeMC = new FakeMCServer({
                minecraft: this.fullConfig.minecraft || {},
                motd: motd || this.fullConfig.motd || {},
                rateLimit: this.fullConfig.rateLimit || {},
            });
            this._instances[uuid] = { fakeMC, name, port };
        }

        const inst = this._instances[uuid];
        inst.fakeMC.setState(state === 'suspended' ? 'suspended' : 'offline');
        inst.name = name;
        inst.port = port;

        if (!inst.fakeMC.isRunning) {
            log.server(TAG, `[${name}] ${state.toUpperCase()} — starting fake MC on port ${port}...`);
            try {
                await inst.fakeMC.start(port);
            } catch (err) {
                if (err.code === 'EADDRINUSE') {
                    log.warn(TAG, `[${name}] Port ${port} in use — will retry next poll`);
                } else {
                    log.error(TAG, `[${name}] Failed to start: ${err.message}`);
                }
            }
        }
    }

    // ─── Local HTTP Server (for controller commands) ────────────────────

    _startHttpServer() {
        return new Promise((resolve, reject) => {
            this._httpServer = http.createServer(async (req, res) => {
                const sendJson = (code, data) => {
                    res.writeHead(code, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(data));
                };

                // Auth check
                const auth = req.headers.authorization || '';
                if (auth !== `Bearer ${this.authToken}`) {
                    return sendJson(401, { error: 'Unauthorized' });
                }

                const segments = (req.url || '').split('/').filter(Boolean);

                // POST /agent/release/:uuid — release a specific port
                if (req.method === 'POST' && segments[0] === 'agent' && segments[1] === 'release' && segments[2]) {
                    const uuid = decodeURIComponent(segments[2]);
                    const inst = this._instances[uuid];
                    if (inst && inst.fakeMC.isRunning) {
                        log.info(TAG, `[${inst.name}] Controller requested port release`);
                        await inst.fakeMC.stop();
                        return sendJson(200, { ok: true, released: true, port: inst.port });
                    }
                    return sendJson(200, { ok: true, released: false, reason: 'Not running' });
                }

                // GET /agent/status — report status
                if (req.method === 'GET' && segments[0] === 'agent' && segments[1] === 'status') {
                    const status = {};
                    for (const [uuid, inst] of Object.entries(this._instances)) {
                        status[uuid] = {
                            name: inst.name,
                            port: inst.port,
                            running: inst.fakeMC.isRunning,
                            state: inst.fakeMC.currentState,
                        };
                    }
                    return sendJson(200, {
                        nodeId: this.nodeId,
                        instances: status,
                        totalInstances: Object.keys(this._instances).length,
                    });
                }

                sendJson(404, { error: 'Not found' });
            });

            this._httpServer.on('error', (err) => {
                log.error(TAG, `Agent HTTP server error: ${err.message}`);
                reject(err);
            });

            this._httpServer.listen(this.agentPort, () => {
                log.success(TAG, `Agent HTTP server listening on port ${this.agentPort}`);
                log.info(TAG, `  POST /agent/release/:uuid — Release a port`);
                log.info(TAG, `  GET  /agent/status        — Agent status`);
                resolve();
            });
        });
    }

    // ─── Start / Stop ───────────────────────────────────────────────────

    async start() {
        // Start local HTTP server for controller commands
        await this._startHttpServer();

        // Register with controller (retry up to 5 times)
        let registered = false;
        for (let i = 0; i < 5; i++) {
            registered = await this.register();
            if (registered) break;
            log.warn(TAG, `Registration attempt ${i + 1}/5 failed — retrying in 5s...`);
            await new Promise((r) => setTimeout(r, 5000));
        }

        if (!registered) {
            log.warn(TAG, 'Could not register with controller — will keep polling anyway');
        }

        // Start polling
        log.info(TAG, `Polling controller every ${this.pollInterval / 1000}s`);
        await this._poll();
        this._timer = setInterval(() => this._poll(), this.pollInterval);
    }

    async stop() {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
        }

        // Stop all FakeMC instances
        for (const inst of Object.values(this._instances)) {
            if (inst.fakeMC.isRunning) {
                await inst.fakeMC.stop();
            }
        }

        // Stop HTTP server
        if (this._httpServer) {
            await new Promise((r) => this._httpServer.close(r));
        }

        log.info(TAG, 'Agent stopped');
    }
}

module.exports = AgentClient;
