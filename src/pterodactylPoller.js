/**
 * OfflineMOTD — Pterodactyl API Poller & Power Controller
 * 
 * Auto-discovers ALL servers from the Pterodactyl Panel API.
 * No manual server configuration needed — it fetches the full server list
 * (with allocations for ports) and monitors every single one.
 * 
 * Uses:
 *   - Application API: list servers, check suspended status, get allocations
 *   - Client API: check power state (running/offline), send power signals
 */

const https = require('https');
const http = require('http');
const log = require('./logger');

const TAG = 'Pterodactyl';

class PterodactylPoller {
    /**
     * @param {object} globalConfig - { panelUrl, apiKey, clientApiKey, pollIntervalMs }
     * @param {function} onServerDiscovered - (server: object) => void — called when a new server is found
     * @param {function} onStatusChange - (serverUuid: string, newState, serverInfo) => void
     */
    constructor(globalConfig, onServerDiscovered, onStatusChange) {
        this.panelUrl = (globalConfig.panelUrl || '').replace(/\/+$/, '');
        this.apiKey = globalConfig.apiKey || '';
        this.clientApiKey = globalConfig.clientApiKey || '';
        this.pollInterval = globalConfig.pollIntervalMs || 60000;
        this.onServerDiscovered = onServerDiscovered;
        this.onStatusChange = onStatusChange;

        this._timer = null;
        this._isPolling = false;

        // All discovered servers keyed by UUID: { [uuid]: { id, uuid, identifier, name, port, ... } }
        this._servers = {};

        // Last known states keyed by UUID: { [uuid]: 'online'|'offline'|'suspended' }
        this._lastStates = {};
    }

    // ─── HTTP Request Helper ────────────────────────────────────────────

    /**
     * Make an HTTP(S) request to the Pterodactyl API
     * @param {'GET'|'POST'} method
     * @param {string} endpoint
     * @param {string} apiKey
     * @param {object|null} postData
     * @returns {Promise<object|null>}
     */
    _apiRequest(method, endpoint, apiKey, postData = null) {
        return new Promise((resolve, reject) => {
            const url = `${this.panelUrl}${endpoint}`;
            let urlObj;
            try {
                urlObj = new URL(url);
            } catch (e) {
                return reject(new Error(`Invalid URL: ${url}`));
            }

            const bodyStr = postData ? JSON.stringify(postData) : null;

            const options = {
                hostname: urlObj.hostname,
                port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
                path: urlObj.pathname + urlObj.search,
                method: method,
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                },
                rejectUnauthorized: false,
            };

            if (bodyStr) {
                options.headers['Content-Length'] = Buffer.byteLength(bodyStr);
            }

            const transport = urlObj.protocol === 'https:' ? https : http;

            const req = transport.request(options, (res) => {
                let body = '';
                res.on('data', (chunk) => (body += chunk));
                res.on('end', () => {
                    if (res.statusCode === 204 || !body.trim()) {
                        return resolve(null);
                    }
                    try {
                        resolve(JSON.parse(body));
                    } catch (e) {
                        reject(new Error(`Failed to parse response (HTTP ${res.statusCode}): ${body.substring(0, 200)}`));
                    }
                });
            });

            req.on('error', (err) => reject(err));
            req.setTimeout(15000, () => req.destroy(new Error('API request timed out')));
            if (bodyStr) req.write(bodyStr);
            req.end();
        });
    }

    // ─── Server Discovery ───────────────────────────────────────────────

    /**
     * Fetch ALL servers from the Pterodactyl Application API (handles pagination).
     * Includes allocations so we know which port each server uses.
     * @returns {Promise<Array>} Array of server objects
     */
    async fetchAllServers() {
        const allServers = [];
        let page = 1;
        let totalPages = 1;

        while (page <= totalPages) {
            try {
                const data = await this._apiRequest(
                    'GET',
                    `/api/application/servers?include=allocations&per_page=50&page=${page}`,
                    this.apiKey
                );

                if (!data || !data.data) {
                    log.warn(TAG, `No data returned from server list (page ${page})`);
                    break;
                }

                // Add servers from this page
                for (const serverObj of data.data) {
                    const attrs = serverObj.attributes || {};
                    
                    // Get the default allocation (primary port)
                    let port = 25565;
                    let ip = '0.0.0.0';
                    const allocations = attrs.relationships?.allocations?.data || [];
                    
                    // Find the default allocation (matching the server's allocation ID)
                    for (const alloc of allocations) {
                        const allocAttrs = alloc.attributes || {};
                        if (allocAttrs.id === attrs.allocation) {
                            port = allocAttrs.port || 25565;
                            ip = allocAttrs.ip || '0.0.0.0';
                            break;
                        }
                    }

                    // If we didn't find the default, use the first allocation
                    if (port === 25565 && allocations.length > 0) {
                        const firstAlloc = allocations[0].attributes || {};
                        port = firstAlloc.port || 25565;
                        ip = firstAlloc.ip || '0.0.0.0';
                    }

                    allServers.push({
                        id: attrs.id,
                        uuid: attrs.uuid,
                        identifier: attrs.identifier || attrs.uuid?.split('-')[0] || String(attrs.id),
                        name: attrs.name || `Server-${attrs.id}`,
                        description: attrs.description || '',
                        suspended: attrs.suspended || false,
                        port: port,
                        ip: ip,
                        node: attrs.node,
                    });
                }

                // Update pagination
                totalPages = data.meta?.pagination?.total_pages || 1;
                page++;
            } catch (err) {
                log.error(TAG, `Failed to fetch server list (page ${page}): ${err.message}`);
                break;
            }
        }

        return allServers;
    }

    /**
     * Discover servers and register new ones
     */
    async discoverServers() {
        log.info(TAG, 'Discovering servers from Pterodactyl Panel...');
        
        const servers = await this.fetchAllServers();

        if (servers.length === 0) {
            log.warn(TAG, 'No servers found on the panel!');
            return;
        }

        let newCount = 0;
        for (const server of servers) {
            const key = server.uuid;

            if (!this._servers[key]) {
                // New server discovered
                this._servers[key] = server;
                newCount++;
                log.success(TAG, `Discovered: ${server.name} (UUID: ${server.uuid}) — Port ${server.port}`);

                if (this.onServerDiscovered) {
                    this.onServerDiscovered(server);
                }
            } else {
                // Update existing server info (name might change, etc.)
                this._servers[key] = { ...this._servers[key], ...server };
            }
        }

        log.info(TAG, `Total servers: ${Object.keys(this._servers).length} (${newCount} new)`);
    }

    // ─── Status Checking ────────────────────────────────────────────────

    /**
     * Check a server's power state via Client API.
     * Uses the short identifier (Pterodactyl client API uses identifier, not full UUID).
     */
    async checkPowerState(serverIdentifier) {
        if (!this.clientApiKey || !serverIdentifier) return 'unknown';

        try {
            const data = await this._apiRequest(
                'GET',
                `/api/client/servers/${serverIdentifier}/resources`,
                this.clientApiKey
            );
            return data?.attributes?.current_state || 'unknown';
        } catch (err) {
            log.debug(TAG, `Power state check failed for ${serverIdentifier}: ${err.message}`);
            return 'unknown';
        }
    }

    /**
     * Determine effective state for a server
     */
    async checkServerStatus(server) {
        // Suspended takes priority (already known from discovery)
        if (server.suspended) return 'suspended';

        // Check power state via client API (uses short identifier)
        const powerState = await this.checkPowerState(server.identifier);
        if (powerState === 'running') return 'online';

        return 'offline';
    }

    // ─── Polling ────────────────────────────────────────────────────────

    /**
     * Run a single poll cycle: re-discover servers + check all statuses
     */
    async _poll() {
        if (this._isPolling) return;
        this._isPolling = true;

        try {
            // Re-discover servers each cycle (picks up new/removed servers)
            await this.discoverServers();

            // Check status for each server
            for (const [uuid, server] of Object.entries(this._servers)) {
                const newState = await this.checkServerStatus(server);

                if (newState !== this._lastStates[uuid]) {
                    const oldState = this._lastStates[uuid] || 'INIT';
                    log.api(TAG, `[${server.name}] ${oldState} → ${newState.toUpperCase()}`);
                    this._lastStates[uuid] = newState;

                    if (this.onStatusChange) {
                        this.onStatusChange(uuid, newState, server);
                    }
                }
            }
        } catch (err) {
            log.error(TAG, `Poll error: ${err.message}`);
        } finally {
            this._isPolling = false;
        }
    }

    /**
     * Start polling
     */
    async startPolling() {
        log.info(TAG, `Starting auto-discovery polling (every ${this.pollInterval / 1000}s)`);
        log.info(TAG, `Panel: ${this.panelUrl}`);
        log.separator();

        // Run immediately, then on interval
        await this._poll();
        this._timer = setInterval(() => this._poll(), this.pollInterval);
    }

    /**
     * Stop polling
     */
    stopPolling() {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
            log.info(TAG, 'Polling stopped');
        }
    }

    // ─── Getters ────────────────────────────────────────────────────────

    getLastState(uuid) {
        return this._lastStates[uuid] || null;
    }

    getAllStates() {
        return { ...this._lastStates };
    }

    getServer(uuid) {
        return this._servers[uuid] || null;
    }

    getAllServers() {
        return { ...this._servers };
    }

    /**
     * Find a server by UUID, identifier, or name.
     * Accepts full UUID, short identifier, or server name (case-insensitive).
     * Returns { uuid, server } or null.
     */
    findServer(query) {
        // Direct UUID match
        if (this._servers[query]) {
            return { uuid: query, server: this._servers[query] };
        }

        // Search by identifier or name
        const lower = query.toLowerCase();
        for (const [uuid, server] of Object.entries(this._servers)) {
            if (
                server.identifier === query ||
                server.name.toLowerCase() === lower ||
                uuid.startsWith(lower)
            ) {
                return { uuid, server };
            }
        }
        return null;
    }

    // ─── Power Control ──────────────────────────────────────────────────

    /**
     * Send a power signal to a server via Pterodactyl Client API.
     * Accepts UUID, identifier, or name.
     * @param {string} serverQuery - UUID, identifier, or name
     * @param {'start'|'stop'|'restart'|'kill'} signal
     */
    async sendPowerSignal(serverQuery, signal) {
        if (!this.clientApiKey) {
            throw new Error('Client API key is required for power control');
        }

        const validSignals = ['start', 'stop', 'restart', 'kill'];
        if (!validSignals.includes(signal)) {
            throw new Error(`Invalid signal: ${signal}. Must be: ${validSignals.join(', ')}`);
        }

        // Resolve to get the server's identifier (used by client API)
        const found = this.findServer(serverQuery);
        const identifier = found?.server?.identifier || serverQuery;
        const serverName = found?.server?.name || serverQuery;

        log.api(TAG, `[${serverName}] Sending power signal: ${signal}`);

        try {
            await this._apiRequest(
                'POST',
                `/api/client/servers/${identifier}/power`,
                this.clientApiKey,
                { signal }
            );
            log.success(TAG, `[${serverName}] Power signal '${signal}' sent successfully`);
            return true;
        } catch (err) {
            log.error(TAG, `[${serverName}] Failed to send '${signal}': ${err.message}`);
            throw err;
        }
    }
}

module.exports = PterodactylPoller;
