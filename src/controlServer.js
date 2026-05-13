/**
 * AlwaysMOTD — HTTP Control Server
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
 */

const http = require('http');
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
    constructor(handlers) {
        this.handlers = handlers;
        this.server = null;
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
                    // ─── POST /api/stop[/:name] ─────────────────────────
                    if (req.method === 'POST' && action === 'stop') {
                        if (name) {
                            log.info(TAG, `Stop request for server: ${name}`);
                        } else {
                            log.info(TAG, 'Stop request for ALL servers');
                        }
                        await this.handlers.onStop(name || null);
                        this._sendJson(res, 200, {
                            success: true,
                            message: name
                                ? `Fake MC server '${name}' stopped, port released`
                                : 'All fake MC servers stopped, ports released',
                        });
                        return;
                    }

                    // ─── POST /api/start[/:name] ────────────────────────
                    if (req.method === 'POST' && action === 'start') {
                        if (name) {
                            log.info(TAG, `Start request for server: ${name}`);
                        } else {
                            log.info(TAG, 'Start request for ALL servers');
                        }
                        await this.handlers.onStart(name || null);
                        this._sendJson(res, 200, {
                            success: true,
                            message: name
                                ? `Fake MC server '${name}' started`
                                : 'All fake MC servers started',
                        });
                        return;
                    }

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

                    // ─── 404 ────────────────────────────────────────────
                    this._sendJson(res, 404, {
                        error: 'Not found',
                        endpoints: [
                            'POST /api/stop[/:serverName]',
                            'POST /api/start[/:serverName]',
                            'POST /api/power/:serverName/:signal  (signal: start|stop|restart|kill)',
                            'GET  /api/status[/:serverName]',
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
}

module.exports = ControlServer;
