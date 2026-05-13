#!/usr/bin/env node
/**
 * OfflineMOTD — Auto-Updater
 *
 * Downloads the latest release from GitHub and updates the installation.
 * Preserves config.json during the update.
 *
 * Usage:
 *   node update.js
 *   npm run update
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ─── ANSI Colors ────────────────────────────────────────────────────────────
const C = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m',
    gray: '\x1b[90m',
};

// ─── Config ─────────────────────────────────────────────────────────────────
const GITHUB_REPO = 'galaxy338/OfflineMOTD';
const API_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
const TARBALL_FALLBACK = `https://github.com/${GITHUB_REPO}/archive/refs/heads/main.tar.gz`;
const ROOT_DIR = __dirname;
const CONFIG_PATH = path.join(ROOT_DIR, 'config.json');
const BACKUP_PATH = path.join(ROOT_DIR, 'config.json.bak');

// Files to preserve (never overwrite)
const PRESERVE_FILES = ['config.json', 'server-icon.png'];

// ─── Helpers ────────────────────────────────────────────────────────────────

function log(msg) {
    console.log(`  ${msg}`);
}

function logOk(msg) {
    console.log(`  ${C.green}✔${C.reset} ${msg}`);
}

function logErr(msg) {
    console.log(`  ${C.red}✖${C.reset} ${msg}`);
}

function logWarn(msg) {
    console.log(`  ${C.yellow}⚠${C.reset} ${msg}`);
}

/**
 * Get current version from package.json
 */
function getCurrentVersion() {
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf-8'));
        return pkg.version || '0.0.0';
    } catch {
        return '0.0.0';
    }
}

/**
 * Make an HTTPS GET request with redirects
 */
function httpsGet(url, headers = {}) {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(url);
        const transport = urlObj.protocol === 'https:' ? https : http;

        const options = {
            hostname: urlObj.hostname,
            port: urlObj.port,
            path: urlObj.pathname + urlObj.search,
            method: 'GET',
            headers: {
                'User-Agent': 'OfflineMOTD-Updater',
                ...headers,
            },
        };

        transport.get(options, (res) => {
            // Follow redirects
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return httpsGet(res.headers.location, headers).then(resolve).catch(reject);
            }

            if (res.statusCode !== 200) {
                return reject(new Error(`HTTP ${res.statusCode}`));
            }

            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => resolve(Buffer.concat(chunks)));
            res.on('error', reject);
        }).on('error', reject);
    });
}

/**
 * Fetch latest release info from GitHub API
 */
async function getLatestRelease() {
    try {
        const data = await httpsGet(API_URL, { Accept: 'application/vnd.github.v3+json' });
        const release = JSON.parse(data.toString('utf-8'));
        return {
            version: (release.tag_name || '').replace(/^v/, ''),
            tagName: release.tag_name,
            tarball: release.tarball_url,
            body: release.body || '',
            htmlUrl: release.html_url,
        };
    } catch (err) {
        // No releases yet — fall back to main branch
        return null;
    }
}

/**
 * Download and extract a tarball, overwriting source files but preserving config
 */
async function downloadAndExtract(tarballUrl) {
    const tmpTar = path.join(ROOT_DIR, '.update.tar.gz');
    const tmpDir = path.join(ROOT_DIR, '.update-extract');

    try {
        // Download
        log(`${C.cyan}Downloading...${C.reset}`);
        const data = await httpsGet(tarballUrl);
        fs.writeFileSync(tmpTar, data);
        logOk(`Downloaded ${(data.length / 1024).toFixed(0)}KB`);

        // Clean extract dir
        if (fs.existsSync(tmpDir)) {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
        fs.mkdirSync(tmpDir, { recursive: true });

        // Extract
        log(`${C.cyan}Extracting...${C.reset}`);
        execSync(`tar -xzf "${tmpTar}" -C "${tmpDir}" --strip-components=1`, { stdio: 'pipe' });
        logOk('Extracted');

        // Backup preserved files
        log(`${C.cyan}Backing up config...${C.reset}`);
        const backups = {};
        for (const file of PRESERVE_FILES) {
            const src = path.join(ROOT_DIR, file);
            if (fs.existsSync(src)) {
                backups[file] = fs.readFileSync(src);
                logOk(`Backed up ${file}`);
            }
        }

        // Copy new files over (skip preserved files)
        log(`${C.cyan}Installing update...${C.reset}`);
        copyDirRecursive(tmpDir, ROOT_DIR, PRESERVE_FILES);
        logOk('Files updated');

        // Restore preserved files
        for (const [file, contents] of Object.entries(backups)) {
            fs.writeFileSync(path.join(ROOT_DIR, file), contents);
        }
        logOk('Config restored');

    } finally {
        // Cleanup temp files
        if (fs.existsSync(tmpTar)) fs.unlinkSync(tmpTar);
        if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
    }
}

/**
 * Recursively copy directory contents, skipping preserved files
 */
function copyDirRecursive(src, dest, skipFiles = []) {
    const entries = fs.readdirSync(src, { withFileTypes: true });

    for (const entry of entries) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);

        // Skip preserved files and hidden/temp files
        if (skipFiles.includes(entry.name)) continue;
        if (entry.name.startsWith('.')) continue;
        if (entry.name === 'node_modules') continue;

        if (entry.isDirectory()) {
            if (!fs.existsSync(destPath)) {
                fs.mkdirSync(destPath, { recursive: true });
            }
            copyDirRecursive(srcPath, destPath, skipFiles);
        } else {
            fs.copyFileSync(srcPath, destPath);
        }
    }
}

/**
 * Compare semver versions: returns 1 if a > b, -1 if a < b, 0 if equal
 */
function compareVersions(a, b) {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
        const va = pa[i] || 0;
        const vb = pb[i] || 0;
        if (va > vb) return 1;
        if (va < vb) return -1;
    }
    return 0;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
    console.log();
    console.log(`${C.cyan}${C.bold}  OfflineMOTD Auto-Updater${C.reset}`);
    console.log(`${C.gray}  ────────────────────────${C.reset}`);
    console.log();

    const currentVersion = getCurrentVersion();
    log(`Current version: ${C.bold}${currentVersion}${C.reset}`);

    // Check for updates
    log(`${C.cyan}Checking for updates...${C.reset}`);
    const release = await getLatestRelease();

    if (release && release.version) {
        log(`Latest version:  ${C.bold}${C.green}${release.version}${C.reset}`);
        console.log();

        if (compareVersions(release.version, currentVersion) <= 0) {
            logOk(`${C.green}You're already on the latest version!${C.reset}`);
            console.log();
            return;
        }

        // Update available
        log(`${C.yellow}Update available: ${currentVersion} → ${release.version}${C.reset}`);
        console.log();

        // Download and install
        await downloadAndExtract(release.tarball);

    } else {
        // No releases — update from main branch
        logWarn('No GitHub releases found — updating from main branch');
        console.log();
        await downloadAndExtract(TARBALL_FALLBACK);
    }

    console.log();
    logOk(`${C.green}${C.bold}Update complete!${C.reset}`);

    if (release && release.body) {
        console.log();
        log(`${C.cyan}What's new:${C.reset}`);
        for (const line of release.body.split('\n').slice(0, 10)) {
            log(`  ${C.gray}${line}${C.reset}`);
        }
    }

    console.log();
    log(`${C.yellow}Please restart the service:${C.reset}`);
    log(`  ${C.dim}systemctl restart offlinemotd${C.reset}`);
    log(`  ${C.dim}— or —${C.reset}`);
    log(`  ${C.dim}pm2 restart offlinemotd${C.reset}`);
    console.log();
}

main().catch((err) => {
    console.error();
    logErr(`Update failed: ${err.message}`);
    console.error();
    process.exit(1);
});
