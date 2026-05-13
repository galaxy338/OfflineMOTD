/**
 * AlwaysMOTD — Logging System
 * 
 * Provides colored console logging with [LEVEL] prefixed format
 * and an ASCII art startup banner.
 */

// ─── ANSI Color Codes ───────────────────────────────────────────────────────
const C = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',

    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    white: '\x1b[37m',
    gray: '\x1b[90m',

    bgRed: '\x1b[41m',
    bgGreen: '\x1b[42m',
    bgYellow: '\x1b[43m',
    bgBlue: '\x1b[44m',
    bgMagenta: '\x1b[45m',
    bgCyan: '\x1b[46m',
};

// ─── ASCII Art Banner ───────────────────────────────────────────────────────
const BANNER = `
${C.cyan}${C.bold}    ___    __                          __  _______  ______ ____ 
${C.cyan}   /   |  / /      ______ ___  _______  /  |/  / __ \\/_  __// __ \\
${C.blue}  / /| | / / | /| / / __ '/ / / / ___/ / /|_/ / / / / / /  / / / /
${C.blue} / ___ |/ /__| |/ |/ / /_/ / /_/ (__  )/ /  / / /_/ / / /  / /_/ / 
${C.magenta}/_/  |_/_____/__/|__/\\__,_/\\__, /____/_/  /_/\\____/ /_/  /_____/  
${C.magenta}                          /____/                                   
${C.reset}
${C.gray}  Pterodactyl-Aware Fake Minecraft MOTD Server${C.reset}
${C.gray}  ─────────────────────────────────────────────${C.reset}
`;

// ─── Level Definitions ──────────────────────────────────────────────────────
const LEVELS = {
    debug: { color: C.gray, label: 'DEBUG' },
    info: { color: C.cyan, label: 'INFO' },
    success: { color: C.green, label: 'OK' },
    warn: { color: C.yellow, label: 'WARN' },
    error: { color: C.red, label: 'ERROR' },
    server: { color: C.magenta, label: 'SERVER' },
    api: { color: C.blue, label: 'API' },
};

// ─── Timestamp ──────────────────────────────────────────────────────────────
function getTimestamp() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// ─── Format: [HH:MM:SS] [LEVEL] [Tag] Message ──────────────────────────────
function formatMessage(level, tag, message) {
    const { color, label } = LEVELS[level] || LEVELS.info;
    const time = `${C.gray}[${getTimestamp()}]${C.reset}`;
    const lvl = `${color}${C.bold}[${label}]${C.reset}`;
    const tagStr = tag ? ` ${C.dim}${C.white}[${tag}]${C.reset}` : '';
    return `${time} ${lvl}${tagStr} ${message}`;
}

// ─── Logger API ─────────────────────────────────────────────────────────────
const logger = {
    /** Print the ASCII art banner */
    banner() {
        console.log(BANNER);
    },

    /** Print a blank separator line */
    separator() {
        console.log(`${C.gray}  ${'─'.repeat(50)}${C.reset}`);
    },

    debug: (tag, msg) => console.log(formatMessage('debug', tag, msg)),
    info: (tag, msg) => console.log(formatMessage('info', tag, msg)),
    success: (tag, msg) => console.log(formatMessage('success', tag, msg)),
    warn: (tag, msg) => console.warn(formatMessage('warn', tag, msg)),
    error: (tag, msg) => console.error(formatMessage('error', tag, msg)),
    server: (tag, msg) => console.log(formatMessage('server', tag, msg)),
    api: (tag, msg) => console.log(formatMessage('api', tag, msg)),
};

module.exports = logger;
