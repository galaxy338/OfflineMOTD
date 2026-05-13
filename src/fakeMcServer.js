/**
 * OfflineMOTD — Fake Minecraft Server
 * 
 * Implements the Minecraft protocol handshake, status ping, and login kick.
 * Based on https://github.com/MrAdhit/FakeMCServer by MrAdhit.
 * 
 * References:
 *   - https://wiki.vg/Server_List_Ping#Response
 *   - https://wiki.vg/Protocol_version_numbers
 *   - https://wiki.vg/Chat
 */

const net = require('net');
const fs = require('fs');
const path = require('path');
const log = require('./logger');

const TAG = 'FakeMC';

// ─── VarInt helpers ─────────────────────────────────────────────────────────

/**
 * Encode an integer as a Minecraft-style VarInt
 */
function writeVarInt(value) {
    value |= 0;
    const result = [];
    while (true) {
        const byte = value & 0x7f;
        value >>>= 7;
        if (value === 0) {
            result.push(byte);
            return Buffer.from(result);
        }
        result.push(byte | 0x80);
    }
}

/**
 * Read a VarInt from a buffer at the given offset.
 * Returns { value, length } where length is bytes consumed.
 */
function readVarInt(buffer, offset = 0) {
    let value = 0;
    let length = 0;
    let byte;
    do {
        if (offset + length >= buffer.length) throw new Error('VarInt: not enough data');
        byte = buffer[offset + length];
        value |= (byte & 0x7f) << (7 * length);
        length++;
        if (length > 5) throw new Error('VarInt: too long');
    } while ((byte & 0x80) !== 0);
    return { value, length };
}

// ─── Encode a JSON response into MC protocol packet ─────────────────────────
function encodePacket(packetId, data) {
    const jsonBuf = Buffer.from(JSON.stringify(data), 'utf-8');
    const packetIdBuf = writeVarInt(packetId);
    const jsonLenBuf = writeVarInt(jsonBuf.length);
    const payload = Buffer.concat([packetIdBuf, jsonLenBuf, jsonBuf]);
    const lengthBuf = writeVarInt(payload.length);
    return Buffer.concat([lengthBuf, payload]);
}

// ─── Load server icon as base64 ─────────────────────────────────────────────
function loadIcon(iconPath) {
    try {
        const resolved = path.resolve(iconPath);
        if (fs.existsSync(resolved)) {
            const stats = fs.statSync(resolved);
            // Minecraft server icon MUST be 64x64 PNG. A proper one is typically 5-15KB.
            // If the file is over 16KB, it's probably not resized and will bloat the response.
            if (stats.size > 16 * 1024) {
                log.warn(TAG, `Server icon is too large (${(stats.size / 1024).toFixed(1)}KB) — must be a 64x64 PNG (max ~16KB). Skipping icon.`);
                return null;
            }
            const base64 = fs.readFileSync(resolved, { encoding: 'base64' });
            log.success(TAG, `Loaded server icon from ${resolved} (${(stats.size / 1024).toFixed(1)}KB)`);
            return `data:image/png;base64,${base64}`;
        }
    } catch (err) {
        log.warn(TAG, `Could not load icon: ${err.message}`);
    }
    return null;
}

// ─── FakeMCServer class ─────────────────────────────────────────────────────
class FakeMCServer {
    constructor(config) {
        this.mcConfig = config.minecraft || {};
        this.motdConfig = config.motd || {};
        this.server = null;
        this.isRunning = false;
        this.currentState = 'offline'; // 'offline' | 'suspended'
        this.adIndex = 0; // Tracks which ad to show next (rotates per ping)

        // Rate limiting: track connections per IP
        this.rateLimit = config.rateLimit || {};
        this.rateLimitMax = this.rateLimit.maxConnections || 10;     // max connections per window
        this.rateLimitWindow = this.rateLimit.windowMs || 60000;     // window in ms (default 60s)
        this._ipHits = new Map(); // IP → [timestamp, timestamp, ...]
        this._rateLimitCleanup = null;

        // Load icon once
        this.favicon = loadIcon(this.mcConfig.icon || './server-icon.png');
    }

    /**
     * Set the current server state (changes the MOTD displayed)
     * @param {'offline'|'suspended'|'installing'|'starting'} state
     */
    setState(state) {
        const valid = ['offline', 'suspended', 'installing', 'starting'];
        if (!valid.includes(state)) return;
        this.currentState = state;
        log.info(TAG, `MOTD state updated to: ${state.toUpperCase()}`);
    }

    /**
     * Build the status response JSON based on current state
     */
    _buildStatusResponse(clientProtocol) {
        const stateMotd = this.motdConfig[this.currentState] || this.motdConfig.offline || {};
        const line1 = stateMotd.line1 || '§cServer Offline';

        // Rotate through ads for line 2
        const ads = stateMotd.ads || [];
        let line2 = stateMotd.line2 || '';
        if (ads.length > 0) {
            line2 = ads[this.adIndex % ads.length];
            this.adIndex = (this.adIndex + 1) % ads.length;
        }

        const response = {
            version: {
                name: this.mcConfig.version || '1.21.5',
                protocol: clientProtocol || this.mcConfig.protocol || 770,
            },
            players: {
                max: stateMotd.maxPlayers ?? 0,
                online: stateMotd.onlinePlayers ?? 0,
                sample: (stateMotd.playerSample || []).map((p) => ({
                    name: p.name || '',
                    id: p.id || '00000000-0000-0000-0000-000000000000',
                })),
            },
            description: {
                text: line1,
                extra: line2
                    ? [{ text: '\n' }, { text: line2 }]
                    : [],
            },
        };

        if (this.favicon) {
            response.favicon = this.favicon;
        }

        return response;
    }

    /**
     * Build the kick message JSON based on current state
     */
    _buildKickMessage() {
        const stateMotd = this.motdConfig[this.currentState] || this.motdConfig.offline || {};
        const kickText = stateMotd.kickMessage || '§cThis server is not available right now.';
        
        return {
            text: kickText,
        };
    }

    /**
     * Start the fake Minecraft server on the given port
     * @param {number} port
     * @returns {Promise<void>}
     */
    start(port) {
        return new Promise((resolve, reject) => {
            if (this.isRunning) {
                log.warn(TAG, 'Server is already running');
                return resolve();
            }

            this.server = net.createServer();

            // Clean up expired rate limit entries periodically
            this._rateLimitCleanup = setInterval(() => {
                const now = Date.now();
                for (const [ip, hits] of this._ipHits) {
                    const valid = hits.filter((t) => now - t < this.rateLimitWindow);
                    if (valid.length === 0) this._ipHits.delete(ip);
                    else this._ipHits.set(ip, valid);
                }
            }, this.rateLimitWindow);
            this._rateLimitCleanup.unref(); // Don't prevent process exit

            this.server.on('connection', (socket) => {
                // ── Rate limiting ──────────────────────────────
                const ip = socket.remoteAddress || 'unknown';
                const now = Date.now();
                const hits = (this._ipHits.get(ip) || []).filter((t) => now - t < this.rateLimitWindow);
                hits.push(now);
                this._ipHits.set(ip, hits);

                if (hits.length > this.rateLimitMax) {
                    log.debug(TAG, `Rate limited ${ip} (${hits.length}/${this.rateLimitMax} in ${this.rateLimitWindow / 1000}s)`);
                    socket.destroy();
                    return;
                }

                // Per-connection state: 0=handshake, 1=status, 2=login
                let connState = 0;
                let clientProtocol = 0;
                let buffer = Buffer.alloc(0);

                socket.on('data', (data) => {
                    buffer = Buffer.concat([buffer, data]);

                    // Process all complete packets in the buffer
                    while (buffer.length > 0) {
                        // Read packet length (VarInt)
                        let packetLength, lenBytes;
                        try {
                            const r = readVarInt(buffer, 0);
                            packetLength = r.value;
                            lenBytes = r.length;
                        } catch {
                            return; // Not enough data for length
                        }

                        // Wait for full packet
                        if (buffer.length - lenBytes < packetLength) return;

                        // Extract packet and advance buffer
                        const packet = buffer.slice(lenBytes, lenBytes + packetLength);
                        buffer = buffer.slice(lenBytes + packetLength);

                        try {
                            // Read packet ID (first VarInt in the packet)
                            const { value: packetId, length: idLen } = readVarInt(packet, 0);
                            const payload = packet.slice(idLen);

                            if (connState === 0 && packetId === 0x00) {
                                // ── Handshake ──────────────────────────
                                // Fields: VarInt protocol, String address, UShort port, VarInt nextState
                                const { value: protocol, length: protoLen } = readVarInt(payload, 0);
                                clientProtocol = protocol;

                                // Skip address string (VarInt length + string bytes)
                                const { value: addrLen, length: addrLenSize } = readVarInt(payload, protoLen);
                                const nextStateOffset = protoLen + addrLenSize + addrLen + 2; // +2 for UShort port
                                const { value: nextState } = readVarInt(payload, nextStateOffset);

                                connState = nextState;
                                log.debug(TAG, `Handshake: protocol=${protocol}, nextState=${nextState}`);

                            } else if (connState === 1 && packetId === 0x00) {
                                // ── Status Request → send Status Response ──
                                const response = this._buildStatusResponse(clientProtocol);
                                const encoded = encodePacket(0x00, response);
                                log.debug(TAG, `Status Request received — sending response (${encoded.length} bytes)`);
                                socket.write(encoded);

                            } else if (connState === 1 && packetId === 0x01) {
                                // ── Ping → send Pong (echo exact packet back) ──
                                const pong = Buffer.concat([writeVarInt(packet.length), packet]);
                                log.debug(TAG, `Ping received — sending Pong (${pong.length} bytes)`);
                                socket.write(pong);

                            } else if (connState === 2 && packetId === 0x00) {
                                // ── Login Start → kick the player ──
                                let playerName = 'Unknown';
                                try {
                                    const { value: nameLen, length: nameLenSize } = readVarInt(payload, 0);
                                    playerName = payload.slice(nameLenSize, nameLenSize + nameLen).toString('utf8');
                                } catch { /* couldn't parse name */ }

                                log.info(TAG, `${playerName} tried to connect — kicking (${this.currentState})`);
                                const kickMsg = this._buildKickMessage();
                                socket.write(encodePacket(0x00, kickMsg));
                                socket.end();
                            }
                        } catch (err) {
                            log.debug(TAG, `Packet parse error: ${err.message}`);
                        }
                    }
                });

                socket.on('error', () => {
                    // Client disconnected or socket error — ignore
                });
            });

            this.server.on('error', (err) => {
                if (err.code === 'EADDRINUSE') {
                    log.error(TAG, `Port ${port} is already in use! The real server may be running.`);
                    this.isRunning = false;
                    reject(err);
                } else {
                    log.error(TAG, `Server error: ${err.message}`);
                    reject(err);
                }
            });

            this.server.listen(port, () => {
                this.isRunning = true;
                log.success(TAG, `Fake Minecraft server listening on port ${port} [${this.currentState.toUpperCase()}]`);
                resolve();
            });
        });
    }

    /**
     * Stop the fake Minecraft server, releasing the port
     * @returns {Promise<void>}
     */
    stop() {
        return new Promise((resolve) => {
            if (!this.isRunning || !this.server) {
                log.warn(TAG, 'Server is not running');
                return resolve();
            }

            this.server.close(() => {
                this.isRunning = false;
                this.server = null;
                if (this._rateLimitCleanup) clearInterval(this._rateLimitCleanup);
                this._ipHits.clear();
                log.success(TAG, 'Fake Minecraft server stopped — port released');
                resolve();
            });

            // Force-close all existing connections
            this.server.unref();
        });
    }
}

module.exports = FakeMCServer;
