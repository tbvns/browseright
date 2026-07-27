import { exec, spawn, execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const execAsync = promisify(exec);

function storeX11VncPassword(passwordFile, password) {
    if (typeof password !== 'string' || password.length === 0) {
        throw new Error('VNC password is required');
    }

    if (/[\r\n\0]/.test(password)) {
        throw new Error('VNC password cannot contain newline or null characters');
    }

    return new Promise((resolve, reject) => {
        const child = spawn('x11vnc', ['-storepasswd', passwordFile], {
            stdio: ['pipe', 'ignore', 'pipe'],
        });

        let stderr = '';

        child.stderr.on('data', (chunk) => {
            stderr += chunk.toString();
        });

        child.stdin.on('error', () => {

        });

        child.on('error', reject);

        child.on('close', (code) => {
            if (code === 0) {
                resolve();
            } else {
                reject(
                    new Error(
                        `x11vnc -storepasswd failed with code ${code}: ${stderr.trim()}`
                    )
                );
            }
        });

        child.stdin.write(`${password}\n`);
        child.stdin.write(`${password}\n`);
        child.stdin.end();
    });
}

class DisplayManager {
    constructor() {
        this.nextDisplay = 99;
        this.nextNoVNCPort = 6080;
        this.activeDisplays = new Map();

        this.noVNCPath = process.env.NOVNC_PATH || '/opt/noVNC';

        // Generate secure random passwords by default
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
            `:${displayNum}`,
            '-screen', '0',
            resolution,
            '-ac',
            '-nolisten', 'tcp'
        ], {
            detached: true,
            stdio: 'ignore'
        });

        xvfb.unref();
        await this._waitForXServer(displayNum);

        this.activeDisplays.set(displayNum, { xvfb });
        return displayNum;
    }

    async startVnc(displayNum, password, port = null) {
        const vncPort = port || (5900 + displayNum);

        let passwordFile = `/tmp/.vncpass_${displayNum}`;
        let authArgs;

        try {
            await storeX11VncPassword(passwordFile, password);

            try {
                fs.chmodSync(passwordFile, 0o600);
            } catch {
                // Best effort only.
            }

            authArgs = ['-rfbauth', passwordFile];
        } catch (err) {
            // Fallback for environments where x11vnc cannot use stdin/tty properly.
            //
            // WARNING: this exposes the password in the process list.
            // In a containerized/single-tenant environment this is usually acceptable,
            // but remove this fallback if you need stricter host security.
            console.warn(
                `[displayManager] x11vnc -storepasswd failed for display :${displayNum}, ` +
                `falling back to -passwd. Reason: ${err.message}`
            );

            passwordFile = null;
            authArgs = ['-passwd', password];
        }

        const vnc = spawn('x11vnc', [
            '-display', `:${displayNum}`,
            '-forever',
            '-shared',
            '-rfbport', String(vncPort),
            ...authArgs,
            '-quiet'
        ], {
            detached: true,
            stdio: 'ignore'
        });

        vnc.unref();

        if (!this.activeDisplays.has(displayNum)) {
            this.activeDisplays.set(displayNum, {});
        }

        const displayInfo = this.activeDisplays.get(displayNum);
        displayInfo.vnc = vnc;
        displayInfo.vncPort = vncPort;
        displayInfo.passwordFile = passwordFile;

        return vncPort;
    }

    async startNoVNC(displayNum, vncPort, password, httpPort = null) {
        const novncPort = httpPort || this.nextNoVNCPort++;

        if (!fs.existsSync(this.noVNCPath)) {
            throw new Error(`noVNC not found at ${this.noVNCPath}. Set NOVNC_PATH environment variable.`);
        }

        // websockify with token-based auth or basic auth
        // For noVNC, we'll use the password in the URL parameter
        const websockify = spawn('websockify', [
            '--web', this.noVNCPath,
            '--target-is-ipv6=false',
            String(novncPort),
            `localhost:${vncPort}`
        ], {
            detached: true,
            stdio: 'ignore'
        });

        websockify.unref();

        const displayInfo = this.activeDisplays.get(displayNum);
        displayInfo.websockify = websockify;
        displayInfo.novncPort = novncPort;

        await this._waitForHttpPort(novncPort);

        return novncPort;
    }

    async createDisplay(resolution = '1920x1080x24', customPassword = undefined) {
        const displayNum = await this.allocateDisplay();

        const password = customPassword !== undefined ? customPassword : this.generatePassword();

        await this.startXvfb(displayNum, resolution);
        const vncPort = await this.startVnc(displayNum, password);
        const novncPort = await this.startNoVNC(displayNum, vncPort, password);

        // Build noVNC URL with password
        const novncUrl = `http://localhost:${novncPort}/vnc.html?host=localhost&port=${novncPort}&password=${encodeURIComponent(password)}&encrypt=0`;

        return {
            displayNum,
            vncPort,
            novncPort,
            password,
            displayEnv: `:${displayNum}`,
            novncUrl
        };
    }

    async cleanupDisplay(displayNum) {
        const displayInfo = this.activeDisplays.get(displayNum);
        if (!displayInfo) return;

        try {
            if (displayInfo.websockify) {
                displayInfo.websockify.kill('SIGTERM');
            }
            if (displayInfo.vnc) {
                displayInfo.vnc.kill('SIGTERM');
            }
            if (displayInfo.xvfb) {
                displayInfo.xvfb.kill('SIGTERM');
            }

            // Clean up password file
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
            } catch (e) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        }

        throw new Error(`X server :${displayNum} failed to start within ${timeout}ms`);
    }

    async _waitForHttpPort(port, timeout = 5000) {
        const startTime = Date.now();

        while (Date.now() - startTime < timeout) {
            try {
                await execAsync(`curl -s -o /dev/null -w "%{http_code}" http://localhost:${port}/ > /dev/null 2>&1`);
                return true;
            } catch (e) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        }

        throw new Error(`HTTP port ${port} failed to respond within ${timeout}ms`);
    }

    async _waitForPort(port, timeout = 5000) {
        await new Promise(resolve => setTimeout(resolve, 100));
    }
}

export const displayManager = new DisplayManager();