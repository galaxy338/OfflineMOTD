/**
 * AlwaysMOTD — Fake Minecraft Server
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

// ─── LEB128 VarInt encoding/decoding ────────────────────────────────────────
// https://en.wikipedia.org/wiki/LEB128
const leb = {
    encode(value) {
        value |= 0;
        const result = [];
        while (true) {
            const byte = value & 0x7f;
            value >>= 7;
            if ((value === 0 && (byte & 0x40) === 0) || (value === -1 && (byte & 0x40) !== 0)) {
                result.push(byte);
                return Buffer.from(result);
            }
            result.push(byte | 0x80);
        }
    },
    decode(input) {
        let result = 0;
        let shift = 0;
        while (true) {
            const byte = input.shift();
            result |= (byte & 0x7f) << shift;
            shift += 7;
            if ((0x80 & byte) === 0) {
                if (shift < 32 && (byte & 0x40) !== 0) {
                    return result | (~0 << shift);
                }
                return result;
            }
        }
    },
};

// ─── Packet parser ──────────────────────────────────────────────────────────
const parsePacket = {
    hostname(buffer) {
        const val1 = 3;
        const val2 = buffer.indexOf(0x00) === -1 ? buffer.length - 3 : buffer.indexOf(0x00) - 4;
        return buffer.slice(val1, val2).toString('utf8');
    },

    port(buffer) {
        const val1 = buffer.indexOf(0x00) === -1 ? buffer.length - 3 : buffer.indexOf(0x00) - 4;
        const val2 = buffer.indexOf(0x00) === -1 ? buffer.length - 1 : buffer.indexOf(0x00) - 2;
        return buffer.slice(val1, val2).readUInt16BE();
    },

    protocol(buffer) {
        return leb.decode(Array.prototype.slice.call(buffer.slice(0, 2)));
    },

    player(rawBuffer, buffer) {
        if (buffer.indexOf(0x00) === -1) return '';
        const val1 = buffer.indexOf(0x00) + 2;
        const val2 = rawBuffer.length;
        return buffer.slice(val1, val2).toString('utf8');
    },

    state(buffer) {
        const val1 = buffer.indexOf(0x00) === -1 ? buffer.length - 1 : buffer.indexOf(0x00) - 2;
        const val2 = buffer.indexOf(0x00) === -1 ? buffer.length : buffer.indexOf(0x00) - 1;
        return buffer.slice(val1, val2).readInt8();
    },
};

// ─── Encode a JSON response into MC protocol packet ─────────────────────────
function encodePacket(data) {
    data = Buffer.from(JSON.stringify(data), 'utf-8');
    return Buffer.concat([
        leb.encode(data.byteLength + leb.encode(data.byteLength).byteLength + 1),
        Buffer.alloc(1),
        leb.encode(data.byteLength),
        data,
    ]);
}

// ─── Load server icon as base64 ─────────────────────────────────────────────
function loadIcon(iconPath) {
    try {
        const resolved = path.resolve(iconPath);
        if (fs.existsSync(resolved)) {
            const base64 = fs.readFileSync(resolved, { encoding: 'base64' });
            log.success(TAG, `Loaded server icon from ${resolved}`);
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

        // Load icon once
        this.favicon = loadIcon(this.mcConfig.icon || './server-icon.png');
    }

    /**
     * Set the current server state (changes the MOTD displayed)
     * @param {'offline'|'suspended'} state
     */
    setState(state) {
        if (state !== 'offline' && state !== 'suspended') return;
        this.currentState = state;
        log.info(TAG, `MOTD state updated to: ${state.toUpperCase()}`);
    }

    /**
     * Build the status response JSON based on current state
     */
    _buildStatusResponse(clientProtocol) {
        const stateMotd = this.motdConfig[this.currentState] || this.motdConfig.offline || {};
        const line1 = stateMotd.line1 || '§cServer Offline';
        const line2 = stateMotd.line2 || '';

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

            this.server.on('connection', (socket) => {
                let buffer = Buffer.alloc(0);

                socket.on('data', (data) => {
                    buffer = Buffer.concat([buffer, data]);

                    const baseBuffer = buffer.slice(buffer.indexOf(0x00) + 1, buffer.length);
                    const hostnameLen = parsePacket.hostname(baseBuffer).length <= 10
                        ? parsePacket.hostname(baseBuffer).length + 10
                        : parsePacket.hostname(baseBuffer).length;

                    if (buffer.length < hostnameLen && buffer.length > 10) return;

                    try {
                        const player = parsePacket.player(buffer, baseBuffer);
                        const protocol = parsePacket.protocol(baseBuffer);
                        const hostname = parsePacket.hostname(baseBuffer);
                        const prt = parsePacket.port(baseBuffer);
                        const state = parsePacket.state(baseBuffer);

                        switch (state) {
                            case 1: {
                                // Status handshake — respond with server list info
                                log.debug(TAG, `Handshake from ${hostname}:${prt} (protocol ${protocol})`);
                                const statusResponse = this._buildStatusResponse(protocol);
                                socket.write(encodePacket(statusResponse));
                                break;
                            }
                            case 2: {
                                // Login attempt — kick the player
                                log.info(TAG, `${player || 'Unknown'} tried to connect to ${hostname}:${prt} — kicking (${this.currentState})`);
                                const kickMsg = this._buildKickMessage();
                                socket.write(encodePacket(kickMsg));
                                break;
                            }
                            default: {
                                // Ping response — echo back
                                log.debug(TAG, 'Responding to ping');
                                socket.write(buffer);
                                break;
                            }
                        }

                        buffer = Buffer.alloc(0);
                    } catch (err) {
                        // Silently handle malformed packets
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
                log.success(TAG, 'Fake Minecraft server stopped — port released');
                resolve();
            });

            // Force-close all existing connections
            this.server.unref();
        });
    }
}

module.exports = FakeMCServer;
