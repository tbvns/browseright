import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import http from 'http';
import net from 'net';
import { WebSocketServer } from 'ws';

const execAsync = promisify(exec);

// ── Configuration ──────────────────────────────────────────────────
const HOST = process.env.VNC_HOST || '0.0.0.0';

// ── MIME types ─────────────────────────────────────────────────────
const MIME_TYPES = {
    '.html': 'text/html',
    '.js':   'application/javascript',
    '.mjs':  'application/javascript',
    '.css':  'text/css',
    '.json': 'application/json',
    '.svg':  'image/svg+xml',
    '.png':  'image/png',
    '.ico':  'image/x-icon',
    '.gif':  'image/gif',
    '.jpg':  'image/jpeg',
    '.woff': 'font/woff',
    '.woff2':'font/woff2',
    '.ttf':  'font/ttf',
    '.map':  'application/json',
};

// ── Non-interactive x11vnc password (2-arg form, no TTY needed) ───
function storeX11VncPassword(passwordFile, password) {
    if (typeof password !== 'string' || password.length === 0) {
        throw new Error('VNC password is required');
    }
    if (/[\r\n\0]/.test(password)) {
        throw new Error('VNC password cannot contain newline or null characters');
    }
    return new Promise((resolve, reject) => {
        const child = spawn('x11vnc', ['-storepasswd', password, passwordFile], {
            stdio: ['ignore', 'ignore', 'pipe'],
        });
        let stderr = '';
        child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
        child.on('error', reject);
        child.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`x11vnc -storepasswd failed (code ${code}): ${stderr.trim()}`));
        });
    });
}

// ── WebSocket-to-TCP proxy (replaces websockify) ───────────────────
function createWsProxy(port, targetHost, targetPort) {
    const server = http.createServer((req, res) => {
        res.writeHead(400);
        res.end('This port serves WebSocket connections only.');
    });

    const wss = new WebSocketServer({ server, path: '/websockify' });

    wss.on('connection', (ws, req) => {
        console.log(`[ws-proxy] Client connected from ${req.socket.remoteAddress}`);

        const tcp = net.connect(targetPort, targetHost, () => {
            console.log(`[ws-proxy] Connected to VNC at ${targetHost}:${targetPort}`);
        });

        // WebSocket → TCP
        ws.on('message', (data, isBinary) => {
            if (tcp.writable) tcp.write(data);
        });

        // TCP → WebSocket
        tcp.on('data', (data) => {
            if (ws.readyState === ws.OPEN) {
                ws.send(data, { binary: true });
            }
        });

        // Cleanup
        ws.on('close', () => {
            console.log(`[ws-proxy] Client disconnected`);
            tcp.destroy();
        });
        ws.on('error', (err) => {
            console.error(`[ws-proxy] WS error: ${err.message}`);
            tcp.destroy();
        });
        tcp.on('close', () => {
            if (ws.readyState === ws.OPEN) ws.close();
        });
        tcp.on('error', (err) => {
            console.error(`[ws-proxy] TCP error: ${err.message}`);
            if (ws.readyState === ws.OPEN) ws.close();
        });
    });

    return new Promise((resolve, reject) => {
        server.listen(port, '0.0.0.0', () => {
            console.log(`[ws-proxy] Listening on 0.0.0.0:${port} → ${targetHost}:${targetPort}`);
            resolve({ server, wss });
        });
        server.on('error', reject);
    });
}

// ── Static file server with correct MIME types ─────────────────────
function createStaticServer(port, rootDir) {
    const server = http.createServer((req, res) => {
        let urlPath = req.url.split('?')[0];
        if (urlPath === '/') urlPath = '/vnc.html';

        const filePath = path.join(rootDir, path.normalize(urlPath));
        if (!filePath.startsWith(path.resolve(rootDir))) {
            res.writeHead(403); res.end('Forbidden'); return;
        }

        fs.readFile(filePath, (err, data) => {
            if (err) { res.writeHead(404); res.end('Not found'); return; }
            const ext  = path.extname(filePath).toLowerCase();
            const mime = MIME_TYPES[ext] || 'application/octet-stream';
            res.writeHead(200, {
                'Content-Type': mime,
                'Access-Control-Allow-Origin': '*',
            });
            res.end(data);
        });
    });

    return new Promise((resolve, reject) => {
        server.listen(port, '0.0.0.0', () => resolve(server));
        server.on('error', reject);
    });
}

// ── Display Manager ────────────────────────────────────────────────
class DisplayManager {
    constructor() {
        this.nextDisplay    = 99;
        this.nextNoVNCPort  = 6080;
        this.activeDisplays = new Map();
        this.noVNCPath      = process.env.NOVNC_PATH || '/opt/noVNC';
        this.defaultPasswordLength = parseInt(process.env.VNC_PASSWORD_LENGTH) || 16;
    }

    generatePassword(length = 8) {
        const effectiveLength = Math.min(Math.max(Number(length) || 8, 8), 8);
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
        let password = '';
        const bytes = crypto.randomBytes(effectiveLength);
        for (let i = 0; i < effectiveLength; i++) {
            password += chars[bytes[i] % chars.length];
        }
        return password;
    }

    async allocateDisplay() {
        const displayNum = this.nextDisplay++;
        await this._waitForPort(6000 + displayNum);
        return displayNum;
    }

    async startXvfb(displayNum, resolution = '1920x1080x24') {
        const xvfb = spawn('Xvfb', [
            `:${displayNum}`, '-screen', '0', resolution, '-ac', '-nolisten', 'tcp'
        ], { detached: true, stdio: 'ignore' });
        xvfb.unref();
        await this._waitForXServer(displayNum);
        this.activeDisplays.set(displayNum, { xvfb });
        return displayNum;
    }

    async startOpenbox(displayNum) {
        const openbox = spawn('openbox', [
            '--display', `:${displayNum}`
        ], {
            detached: true,
            stdio: 'ignore',
            env: { ...process.env, DISPLAY: `:${displayNum}` }
        });
        openbox.unref();

        // Wait briefly for Openbox to initialize
        await new Promise(resolve => setTimeout(resolve, 500));

        if (!this.activeDisplays.has(displayNum)) {
            this.activeDisplays.set(displayNum, {});
        }
        const displayInfo = this.activeDisplays.get(displayNum);
        displayInfo.openbox = openbox;

        console.log(`[displayManager] Openbox started on display :${displayNum}`);
    }

    async startVnc(displayNum, password, port = null) {
        const vncPort = port || (5900 + displayNum);
        let passwordFile = `/tmp/.vncpass_${displayNum}`;
        let authArgs;

        try {
            await storeX11VncPassword(passwordFile, password);
            try { fs.chmodSync(passwordFile, 0o600); } catch { /* best effort */ }
            authArgs = ['-rfbauth', passwordFile];
        } catch (err) {
            console.warn(
                `[displayManager] x11vnc -storepasswd failed for display :${displayNum}, ` +
                `falling back to -passwd. Reason: ${err.message}`
            );
            passwordFile = null;
            authArgs = ['-passwd', password];
        }

        const vnc = spawn('x11vnc', [
            '-display', `:${displayNum}`,
            '-forever', '-shared',
            '-rfbport', String(vncPort),
            ...authArgs, '-quiet'
        ], { detached: true, stdio: 'ignore' });
        vnc.unref();

        if (!this.activeDisplays.has(displayNum)) {
            this.activeDisplays.set(displayNum, {});
        }
        const displayInfo = this.activeDisplays.get(displayNum);
        displayInfo.vnc          = vnc;
        displayInfo.vncPort      = vncPort;
        displayInfo.passwordFile = passwordFile;
        return vncPort;
    }

    // ── No more websockify binary — pure Node.js proxy ─────────────
    async startNoVNC(displayNum, vncPort, password, httpPort = null) {
        const novncPort  = httpPort || this.nextNoVNCPort++;
        const staticPort = novncPort + 1000;

        if (!fs.existsSync(this.noVNCPath)) {
            throw new Error(`noVNC not found at ${this.noVNCPath}. Set NOVNC_PATH env var.`);
        }

        // 1) WebSocket-to-TCP proxy (replaces websockify)
        const { server: wsServer, wss } = await createWsProxy(novncPort, '127.0.0.1', vncPort);

        // 2) Static file server (replaces websockify --web)
        const staticServer = await createStaticServer(staticPort, this.noVNCPath);

        const displayInfo = this.activeDisplays.get(displayNum);
        displayInfo.wsServer     = wsServer;
        displayInfo.wss          = wss;
        displayInfo.staticServer = staticServer;
        displayInfo.novncPort    = novncPort;
        displayInfo.staticPort   = staticPort;

        return { novncPort, staticPort };
    }

    async createDisplay(resolution = '1920x1080x24', customPassword = undefined) {
        const displayNum = await this.allocateDisplay();
        const password   = customPassword !== undefined ? customPassword : this.generatePassword();

        await this.startXvfb(displayNum, resolution);
        await this.startOpenbox(displayNum);

        const vncPort = await this.startVnc(displayNum, password);
        const { novncPort, staticPort } = await this.startNoVNC(displayNum, vncPort, password);

        const novncUrl =
            `http://${HOST}:${staticPort}/vnc.html` +
            `?host=${HOST}&port=${novncPort}` +
            `&password=${encodeURIComponent(password)}&encrypt=0`;

        console.log(`Creating browser on display :${displayNum}`);
        console.log(`  VNC port:    ${vncPort}`);
        console.log(`  WS port:     ${novncPort}  (Node ws-proxy)`);
        console.log(`  Static port: ${staticPort}  (noVNC UI)`);
        console.log(`  Password:    ${password}`);
        console.log(`  URL:         ${novncUrl}`);

        return {
            displayNum, vncPort, novncPort, staticPort,
            password, displayEnv: `:${displayNum}`, novncUrl,
        };
    }

    async cleanupDisplay(displayNum) {
        const displayInfo = this.activeDisplays.get(displayNum);
        if (!displayInfo) return;
        try {
            if (displayInfo.wss)          displayInfo.wss.close();
            if (displayInfo.wsServer)     displayInfo.wsServer.close();
            if (displayInfo.staticServer) displayInfo.staticServer.close();
            if (displayInfo.vnc)          displayInfo.vnc.kill('SIGTERM');
            if (displayInfo.xvfb)         displayInfo.xvfb.kill('SIGTERM');
            if (displayInfo.passwordFile && fs.existsSync(displayInfo.passwordFile)) {
                fs.unlinkSync(displayInfo.passwordFile);
            }
        } catch (e) {
            console.error(`Error cleaning up display :${displayNum}`, e);
        }
        this.activeDisplays.delete(displayNum);
    }

    async _waitForXServer(displayNum, timeout = 10000) {
        const startTime = Date.now();
        while (Date.now() - startTime < timeout) {
            try {
                await execAsync(`xdpyinfo -display :${displayNum} > /dev/null 2>&1`);
                return true;
            } catch { await new Promise(r => setTimeout(r, 100)); }
        }
        throw new Error(`X server :${displayNum} failed to start within ${timeout}ms`);
    }

    async _waitForPort(port, timeout = 5000) {
        await new Promise(resolve => setTimeout(resolve, 100));
    }
}

export const displayManager = new DisplayManager();