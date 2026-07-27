import { chromium } from 'patchright';
import crypto from 'node:crypto';
import {displayManager} from "../screens/displayManager.js";

const browsers = new Map();
const contexts = new Map();
const pages = new Map();

const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours
const IDLE_CLEANUP_DEFAULT_INTERVAL_MS = 60 * 1000;

/* ======================= anti-detection config ========================== */

const REALISTIC_VIEWPORT = { width: 720, height: 1040 };
const REALISTIC_LOCALE = 'fr-FR';
const REALISTIC_TIMEZONE = 'Europe/Paris';

const LAUNCH_ARGS = [
    '--disable-blink-features=AutomationControlled',
    '--disable-features=AutomationControllerForContentScripts',
    '--disable-infobars',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-ipc-flooding-protection',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-popup-blocking',
    '--disable-hang-monitor',
    '--disable-sync',
    '--metrics-recording-only',
    '--enable-features=NetworkService,NetworkServiceInProcess',
];

const STEALTH_INIT_SCRIPT = `
(() => {
    'use strict';

    /* ==================================================================
     * 1. Remove own properties from the navigator INSTANCE.
     *
     * Patchright's Chromium defines these as own properties on the
     * navigator object, which is detectable:
     *   Object.getOwnPropertyNames(navigator)
     *   → ["webdriver","plugins","mimeTypes","languages",
     *      "deviceMemory","hardwareConcurrency"]
     *
     * In a real browser this returns [].  All these properties live on
     * Navigator.prototype.  Deleting the own properties lets the native
     * prototype getters take over (Patchright patches webdriver at the
     * C++ level to return false with a native descriptor).
     * ================================================================== */
    const _ownProps = [
        'webdriver', 'plugins', 'mimeTypes',
        'languages', 'deviceMemory', 'hardwareConcurrency',
    ];
    for (const _p of _ownProps) {
        try { delete navigator[_p]; } catch (_) {}
    }

    /* ==================================================================
     * 2. navigator.plugins → 5 realistic Chrome PDF plugins.
     *    Redefined on Navigator.prototype (main-thread only API —
     *    workers don't have plugins, so no inconsistency).
     * ================================================================== */
    const _makePlugin = (name, desc, filename, mimes) => {
        const p = Object.create(Plugin.prototype);
        Object.defineProperties(p, {
            name:        { get: () => name,     enumerable: true, configurable: true },
            description: { get: () => desc,     enumerable: true, configurable: true },
            filename:    { get: () => filename, enumerable: true, configurable: true },
            length:      { get: () => mimes.length, enumerable: true, configurable: true },
        });
        mimes.forEach((mt, i) => {
            Object.defineProperty(p, String(i), {
                get: () => mt, enumerable: true, configurable: true,
            });
        });
        return p;
    };

    const _pdfMime = Object.create(MimeType.prototype);
    Object.defineProperties(_pdfMime, {
        type:        { get: () => 'application/pdf', enumerable: true, configurable: true },
        suffixes:    { get: () => 'pdf',             enumerable: true, configurable: true },
        description: { get: () => 'Portable Document Format', enumerable: true, configurable: true },
    });

    const _pdfxMime = Object.create(MimeType.prototype);
    Object.defineProperties(_pdfxMime, {
        type:        { get: () => 'text/pdf', enumerable: true, configurable: true },
        suffixes:    { get: () => 'pdf',      enumerable: true, configurable: true },
        description: { get: () => '',         enumerable: true, configurable: true },
    });

    const _plugins = [
        _makePlugin('PDF Viewer',               'Portable Document Format', 'internal-pdf-viewer', [_pdfMime]),
        _makePlugin('Chrome PDF Viewer',        'Portable Document Format', 'internal-pdf-viewer', [_pdfMime]),
        _makePlugin('Chromium PDF Viewer',      'Portable Document Format', 'internal-pdf-viewer', [_pdfMime]),
        _makePlugin('Microsoft Edge PDF Viewer','Portable Document Format', 'internal-pdf-viewer', [_pdfMime]),
        _makePlugin('WebKit built-in PDF',      'Portable Document Format', 'internal-pdf-viewer', [_pdfMime]),
    ];

    Object.defineProperty(Navigator.prototype, 'plugins', {
        get: () => {
            const list = Object.create(PluginArray.prototype);
            _plugins.forEach((p, i) => {
                Object.defineProperty(list, String(i), {
                    get: () => p, enumerable: true, configurable: true,
                });
            });
            Object.defineProperty(list, 'length', {
                get: () => _plugins.length, enumerable: true, configurable: true,
            });
            list.item = (i) => _plugins[i] || null;
            list.namedItem = (n) => _plugins.find((p) => p.name === n) || null;
            list.refresh = () => {};
            list[Symbol.iterator] = function* () { yield* _plugins; };
            return list;
        },
        configurable: true,
        enumerable: true,
    });

    /* ==================================================================
     * 3. navigator.mimeTypes → 2 PDF MIME types (main-thread only).
     * ================================================================== */
    const _mimes = [_pdfMime, _pdfxMime];
    Object.defineProperty(Navigator.prototype, 'mimeTypes', {
        get: () => {
            const list = Object.create(MimeTypeArray.prototype);
            _mimes.forEach((m, i) => {
                Object.defineProperty(list, String(i), {
                    get: () => m, enumerable: true, configurable: true,
                });
            });
            Object.defineProperty(list, 'length', {
                get: () => _mimes.length, enumerable: true, configurable: true,
            });
            list.item = (i) => _mimes[i] || null;
            list.namedItem = (n) => _mimes.find((m) => m.type === n) || null;
            list[Symbol.iterator] = function* () { yield* _mimes; };
            return list;
        },
        configurable: true,
        enumerable: true,
    });

    /* ==================================================================
     * 4. window.chrome.runtime → realistic stub (main-thread only).
     * ================================================================== */
    if (!window.chrome) window.chrome = {};
    if (!window.chrome.runtime) {
        window.chrome.runtime = {
            OnInstalledReason: {
                CHROME_UPDATE: 'chrome_update',
                INSTALL: 'install',
                SHARED_MODULE_UPDATE: 'shared_module_update',
                UPDATE: 'update',
            },
            OnRestartRequiredReason: {
                APP_UPDATE: 'app_update',
                OS_UPDATE: 'os_update',
                PERIODIC: 'periodic',
            },
            PlatformArch: {
                ARM: 'arm', ARM64: 'arm64', MIPS: 'mips',
                MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64',
            },
            PlatformNaclArch: {
                ARM: 'arm', MIPS: 'mips', MIPS64: 'mips64',
                X86_32: 'x86-32', X86_64: 'x86-64',
            },
            PlatformOs: {
                ANDROID: 'android', CROS: 'cros', LINUX: 'linux',
                MAC: 'mac', OPENBSD: 'openbsd', WIN: 'win',
            },
            RequestUpdateCheckStatus: {
                NO_UPDATE: 'no_update',
                THROTTLED: 'throttled',
                UPDATE_AVAILABLE: 'update_available',
            },
            connect() {
                return {
                    onDisconnect: { addListener() {} },
                    onMessage:    { addListener() {} },
                    postMessage() {},
                };
            },
            sendMessage() {
                const cb = arguments[arguments.length - 1];
                if (typeof cb === 'function') cb();
            },
        };
    }

    /* ==================================================================
     * 5. window.outerWidth / outerHeight → match screen (main-thread).
     * ================================================================== */
    Object.defineProperty(window, 'outerWidth', {
        get: () => window.screen.width,
        configurable: true,
    });
    Object.defineProperty(window, 'outerHeight', {
        get: () => window.screen.height,
        configurable: true,
    });
})();
`;

/* ------------------------- end anti-detection --------------------------- */

function parseMsEnv(name, fallback) {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    const ms = Number(raw);
    return Number.isFinite(ms) && ms >= 0 ? ms : fallback;
}

const IDLE_TIMEOUT_MS = parseMsEnv(
    'BROWSER_IDLE_TIMEOUT_MS',
    DEFAULT_IDLE_TIMEOUT_MS
);
const IDLE_CLEANUP_INTERVAL_MS = Math.max(
    1_000,
    parseMsEnv(
        'BROWSER_IDLE_CLEANUP_INTERVAL_MS',
        IDLE_CLEANUP_DEFAULT_INTERVAL_MS
    )
);

const toId = (id) => id || crypto.randomUUID();
const toTimeout = (t) =>
    Number.isFinite(Number(t)) && Number(t) > 0 ? Number(t) : DEFAULT_TIMEOUT;

function badRequest(message) {
    const err = new Error(message);
    err.status = 400;
    return err;
}

function notFound(message) {
    const err = new Error(message);
    err.status = 404;
    return err;
}

function sendError(res, err, fallback = 500) {
    const status =
        err?.status || (err?.name === 'TimeoutError' ? 504 : fallback);
    res.status(status).json({
        error: err?.message || String(err),
        name: err?.name,
        code: err?.code,
        stack: process.env.NODE_ENV === 'development' ? err?.stack : undefined,
    });
}

function asyncRoute(fn) {
    return async (req, res, next) => {
        try {
            await fn(req, res, next);
        } catch (err) {
            sendError(res, err);
        }
    };
}

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function safePageSummary(entry) {
    return {
        id: entry.id,
        browserId: entry.browserId,
        url: entry.page.isClosed() ? null : entry.page.url(),
        closed: entry.page.isClosed(),
        createdAt: entry.createdAt,
    };
}

function removePageEntry(pageEntry) {
    if (!pageEntry) return;
    pages.delete(pageEntry.id);
    contexts.get(pageEntry.contextId)?.pages.delete(pageEntry.id);
    browsers.get(pageEntry.browserId)?.pages.delete(pageEntry.id);
}

function removeContextEntry(contextEntry) {
    if (!contextEntry) return;
    for (const pageEntry of [...contextEntry.pages.values()]) {
        removePageEntry(pageEntry);
    }
    contexts.delete(contextEntry.id);
    browsers.get(contextEntry.browserId)?.contexts.delete(contextEntry.id);
}

let idleCleanupTimer = null;
let idleCleanupRunning = false;

function toIdleTimeout(value) {
    if (value === undefined || value === null) return undefined;
    const ms = Number(value);
    return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
}

function touchBrowser(browserId, force = false) {
    const entry = browsers.get(browserId);
    if (!entry) return;
    const now = Date.now();
    if (!force && now - (entry.lastUsedAt || 0) < 5_000) return;
    entry.lastUsedAt = now;
}

function getBrowserIdleTimeoutMs(entry) {
    if (entry && entry.idleTimeoutMs !== undefined) {
        const ms = Number(entry.idleTimeoutMs);
        if (Number.isFinite(ms) && ms >= 0) return ms;
    }
    const ms = Number(IDLE_TIMEOUT_MS);
    if (Number.isFinite(ms) && ms >= 0) return ms;
    return DEFAULT_IDLE_TIMEOUT_MS;
}

function isBrowserIdle(entry, now = Date.now()) {
    const timeout = getBrowserIdleTimeoutMs(entry);
    if (timeout <= 0) return false;
    const lastUsedAt =
        entry.lastUsedAt || Date.parse(entry.createdAt) || 0;
    return now - lastUsedAt > timeout;
}

function forceCleanupBrowserEntry(entry) {
    if (!entry) return;
    for (const contextEntry of [...entry.contexts.values()]) {
        removeContextEntry(contextEntry);
    }
    for (const pageEntry of [...entry.pages.values()]) {
        removePageEntry(pageEntry);
    }
    browsers.delete(entry.id);
}

async function closeIdleBrowser(entry) {
    if (!entry) return;
    try {
        if (entry.browser?.isConnected?.()) {
            await entry.browser.close();
        }
    } catch {
        // Best effort only.
    }
    forceCleanupBrowserEntry(entry);
}

export function startIdleBrowserCleanup() {
    if (idleCleanupTimer) return;
    idleCleanupTimer = setInterval(async () => {
        if (idleCleanupRunning) return;
        idleCleanupRunning = true;
        try {
            const now = Date.now();
            const staleBrowsers = [...browsers.values()].filter((entry) =>
                isBrowserIdle(entry, now)
            );
            await Promise.allSettled(
                staleBrowsers.map((entry) => closeIdleBrowser(entry))
            );
        } finally {
            idleCleanupRunning = false;
        }
    }, IDLE_CLEANUP_INTERVAL_MS);
    idleCleanupTimer.unref?.();
}

export function stopIdleBrowserCleanup() {
    if (idleCleanupTimer) {
        clearInterval(idleCleanupTimer);
        idleCleanupTimer = null;
    }
}

startIdleBrowserCleanup();

async function navResult(page) {
    return {
        url: page.url(),
        title: await page.title().catch(() => ''),
    };
}

function attachPage(pageId, page, browserId, contextId) {
    if (pages.has(pageId)) {
        throw badRequest(`Page id "${pageId}" already exists`);
    }
    const pageEntry = {
        id: pageId,
        browserId,
        contextId,
        page,
        createdAt: new Date().toISOString(),
    };
    page.on('close', () => removePageEntry(pageEntry));
    pages.set(pageId, pageEntry);
    contexts.get(contextId)?.pages.set(pageId, pageEntry);
    browsers.get(browserId)?.pages.set(pageId, pageEntry);
    return pageEntry;
}

async function withPage(pageId, fn) {
    const entry = getPageEntry(pageId);
    return await fn(entry.page, entry);
}

/* ----------------------------- browser APIs ----------------------------- */

export async function createBrowser(customPassword = undefined) {
    const id = crypto.randomUUID();

    const { displayNum, vncPort, novncPort, password, novncUrl } =
        await displayManager.createDisplay('740x1080x24', customPassword);

    console.log(`Creating browser ${id} on display :${displayNum}`);
    console.log(`  VNC port: ${vncPort}`);
    console.log(`  NoVNC port: ${novncPort}`);
    console.log(`  Password: ${password}`);

    const browser = await chromium.launch({
        headless: false,
        args: LAUNCH_ARGS,
        env: {
            ...process.env,
            DISPLAY: `:${displayNum}`
        },
        executablePath: '/usr/bin/chromium'
    });

    const entry = {
        id,
        browser,
        displayNum,
        vncPort,
        novncPort,
        password,
        version: browser.version(),
        contexts: new Map(),
        pages: new Map(),
        createdAt: new Date().toISOString(),
        lastUsedAt: Date.now(),
        idleTimeoutMs: toIdleTimeout(undefined),
    };

    browsers.set(id, entry);

    browser.on('disconnected', async () => {
        console.log(`Browser ${id} disconnected, cleaning up display :${displayNum}`);

        for (const contextEntry of [...entry.contexts.values()]) {
            removeContextEntry(contextEntry);
        }
        for (const pageEntry of [...entry.pages.values()]) {
            removePageEntry(pageEntry);
        }

        browsers.delete(id);
        await displayManager.cleanupDisplay(displayNum);
    });

    return {
        id,
        browser,
        displayNum,
        vncPort,
        novncPort,
        password,
        novncUrl
    };
}

export function getBrowserEntry(id) {
    const entry = browsers.get(id);
    if (!entry) throw notFound(`Browser with id "${id}" not found`);
    touchBrowser(id, true);
    return entry;
}

export async function closeBrowser(id) {
    const entry = getBrowserEntry(id);
    await entry.browser.close();
    browsers.delete(id);
}

export async function closeAllBrowsers() {
    const ids = [...browsers.keys()];
    await Promise.allSettled(
        ids.map((id) => browsers.get(id)?.browser.close())
    );
    for (const id of ids) browsers.delete(id);
    return { closed: ids.length };
}

export function listBrowsers() {
    return [...browsers.values()].map((entry) => ({
        id: entry.id,
        createdAt: entry.createdAt,
        lastUsedAt: entry.lastUsedAt
            ? new Date(entry.lastUsedAt).toISOString()
            : null,
        idleTimeoutMs: getBrowserIdleTimeoutMs(entry),
        connected: entry.browser.isConnected(),
        pages: [...entry.pages.keys()],
    }));
}

export function getBrowserInfo(id) {
    const entry = getBrowserEntry(id);
    return {
        id: entry.id,
        createdAt: entry.createdAt,
        lastUsedAt: entry.lastUsedAt
            ? new Date(entry.lastUsedAt).toISOString()
            : null,
        idleTimeoutMs: getBrowserIdleTimeoutMs(entry),
        connected: entry.browser.isConnected(),
        pages: [...entry.pages.values()].map(safePageSummary),
    };
}

/* ----------------------------- context APIs ----------------------------- */

async function createContextInternal(browserId, contextId) {
    const browserEntry = getBrowserEntry(browserId);
    const id = contextId || crypto.randomUUID();
    if (contexts.has(id)) {
        throw badRequest(`Context with id "${id}" already exists`);
    }

    const version = browserEntry.version;

    const context = await browserEntry.browser.newContext({
        locale: REALISTIC_LOCALE,
        timezoneId: REALISTIC_TIMEZONE,
        deviceScaleFactor: 1,
        hasTouch: false,
        isMobile: false,
        javaScriptEnabled: true,
        colorScheme: 'light',
        viewport: null,
    });

    // Inject stealth patches (main-thread-only APIs)
    // await context.addInitScript(STEALTH_INIT_SCRIPT);

    const contextEntry = {
        id,
        browserId,
        context,
        pages: new Map(),
        createdAt: new Date().toISOString(),
    };
    browserEntry.contexts.set(id, contextEntry);
    contexts.set(id, contextEntry);
    context.on('close', () => removeContextEntry(contextEntry));
    return contextEntry;
}

async function getOrCreateDefaultContext(browserId) {
    const browserEntry = getBrowserEntry(browserId);
    const defaultId = `default-${browserId}`;
    let contextEntry = browserEntry.contexts.get(defaultId);
    if (contextEntry) return contextEntry;
    await createContextInternal(browserId, defaultId);
    return browserEntry.contexts.get(defaultId);
}

/* ------------------------------- page APIs ------------------------------ */

export async function newPage(browserId) {
    const browserEntry = getBrowserEntry(browserId);
    const contextEntry = await getOrCreateDefaultContext(browserId);
    const page = await contextEntry.context.newPage();
    const pageId = crypto.randomUUID();
    attachPage(pageId, page, browserId, contextEntry.id);

    return { id: pageId };
}

export function getPageEntry(pageId) {
    const entry = pages.get(pageId);
    if (!entry) throw notFound(`Page with id "${pageId}" not found`);
    if (entry.page.isClosed()) throw badRequest('Page is closed');
    touchBrowser(entry.browserId, true);
    return entry;
}

export async function closePage(pageId) {
    const entry = getPageEntry(pageId);
    await entry.page.close();
    removePageEntry(entry);
}

export function listPages(browserId = null) {
    let entries = [...pages.values()];
    if (browserId) {
        getBrowserEntry(browserId);
        entries = entries.filter((entry) => entry.browserId === browserId);
    }
    return entries.map(safePageSummary);
}

export async function getPageInfo(pageId) {
    return withPage(pageId, async (page) => ({
        id: pageId,
        url: page.url(),
        title: await page.title().catch(() => ''),
        isClosed: page.isClosed(),
    }));
}

/* ----------------------------- navigation ------------------------------- */

export async function goto(pageId, url, options = {}) {
    if (!url) throw badRequest('url is required');
    return withPage(pageId, async (page) => {
        const response = await page.goto(url, {
            timeout: toTimeout(options.timeout),
            waitUntil: options.waitUntil ?? 'load',
        });
        return {
            status: response?.status() ?? null,
            ok: response?.ok() ?? null,
            ...(await navResult(page)),
        };
    });
}

export async function goBack(pageId, options = {}) {
    return withPage(pageId, async (page) => {
        const response = await page.goBack({
            timeout: toTimeout(options.timeout),
            waitUntil: options.waitUntil ?? 'load',
        });
        return {
            status: response?.status() ?? null,
            ...(await navResult(page)),
        };
    });
}

export async function goForward(pageId, options = {}) {
    return withPage(pageId, async (page) => {
        const response = await page.goForward({
            timeout: toTimeout(options.timeout),
            waitUntil: options.waitUntil ?? 'load',
        });
        return {
            status: response?.status() ?? null,
            ...(await navResult(page)),
        };
    });
}

export async function reload(pageId, options = {}) {
    return withPage(pageId, async (page) => {
        const response = await page.reload({
            timeout: toTimeout(options.timeout),
            waitUntil: options.waitUntil ?? 'load',
        });
        return {
            status: response?.status() ?? null,
            ...(await navResult(page)),
        };
    });
}

/* -------------------------------- waits --------------------------------- */

export async function waitForLoadState(pageId, state = 'load', options = {}) {
    return withPage(pageId, async (page) => {
        await page.waitForLoadState(state, {
            timeout: toTimeout(options.timeout),
        });
        return { ok: true, state };
    });
}

export async function waitForSelector(pageId, selector, options = {}) {
    if (!selector) throw badRequest('selector is required');
    return withPage(pageId, async (page) => {
        const handle = await page.waitForSelector(selector, {
            timeout: toTimeout(options.timeout),
            state: options.state ?? 'visible',
        });
        await handle?.dispose?.().catch(() => {});
        return {
            found: true,
            state: options.state ?? 'visible',
        };
    });
}

export async function waitForURL(pageId, url, options = {}) {
    if (!url) throw badRequest('url is required');
    return withPage(pageId, async (page) => {
        const target =
            typeof url === 'string' && url.includes('*')
                ? new RegExp(`^${url.split('*').map(escapeRegExp).join('.*')}$`)
                : url;
        await page.waitForURL(target, {
            timeout: toTimeout(options.timeout),
            waitUntil: options.waitUntil ?? 'load',
        });
        return await navResult(page);
    });
}

export async function waitForNetworkIdle(pageId, options = {}) {
    return withPage(pageId, async (page) => {
        await page.waitForLoadState('networkidle', {
            timeout: toTimeout(options.timeout),
        });
        return { ok: true };
    });
}

/* ------------------------------ content --------------------------------- */

export async function getContent(pageId) {
    return withPage(pageId, async (page) => page.content());
}

/* -------------------------------- actions ------------------------------- */

export async function click(pageId, selector, options = {}) {
    if (!selector) throw badRequest('selector is required');
    return withPage(pageId, async (page) => {
        await page
            .locator(selector)
            .first()
            .click({
                timeout: toTimeout(options.timeout),
            });
        return {
            clicked: selector,
            ...(await navResult(page).catch(() => ({}))),
        };
    });
}

export async function clickText(pageId, text, options = {}) {
    if (!text) throw badRequest('text is required');
    return withPage(pageId, async (page) => {
        await page
            .getByText(text, { exact: options.exact ?? false })
            .first()
            .click({
                timeout: toTimeout(options.timeout),
            });
        return {
            clickedText: text,
            ...(await navResult(page).catch(() => ({}))),
        };
    });
}

export async function clickRole(pageId, role, options = {}) {
    if (!role) throw badRequest('role is required');
    return withPage(pageId, async (page) => {
        await page
            .getByRole(role, {
                name: options.name,
                exact: options.exact,
            })
            .first()
            .click({
                timeout: toTimeout(options.timeout),
            });
        return {
            clickedRole: role,
            ...(await navResult(page).catch(() => ({}))),
        };
    });
}

export async function fill(pageId, selector, value, options = {}) {
    if (!selector) throw badRequest('selector is required');
    return withPage(pageId, async (page) => {
        await page
            .locator(selector)
            .first()
            .fill(value ?? '', {
                timeout: toTimeout(options.timeout),
            });
        return { filled: selector };
    });
}

export async function fillByLabel(pageId, label, value, options = {}) {
    if (!label) throw badRequest('label is required');
    return withPage(pageId, async (page) => {
        await page
            .getByLabel(label, { exact: options.exact ?? false })
            .first()
            .fill(value ?? '', {
                timeout: toTimeout(options.timeout),
            });
        return { filledByLabel: label };
    });
}

export async function press(pageId, selector, key, options = {}) {
    if (!key) throw badRequest('key is required');
    return withPage(pageId, async (page) => {
        if (selector) {
            await page
                .locator(selector)
                .first()
                .press(key, {
                    timeout: toTimeout(options.timeout),
                });
        } else {
            await page.keyboard.press(key);
        }
        return { pressed: key };
    });
}

export async function selectOption(pageId, selector, values, options = {}) {
    if (!selector) throw badRequest('selector is required');
    return withPage(pageId, async (page) => {
        const selected = await page
            .locator(selector)
            .first()
            .selectOption(values ?? [], {
                timeout: toTimeout(options.timeout),
            });
        return { selector, selected };
    });
}

export async function selectByLabel(pageId, label, values, options = {}) {
    if (!label) throw badRequest('label is required');
    return withPage(pageId, async (page) => {
        const selected = await page
            .getByLabel(label, { exact: options.exact ?? false })
            .first()
            .selectOption(values ?? [], {
                timeout: toTimeout(options.timeout),
            });
        return { selectedByLabel: label, selected };
    });
}

/* -------------------------------- routes -------------------------------- */

export default function setupBrowserRoutes(app) {
    /* ------------------------------ browsers ------------------------------ */
    app.post(
        '/api/browser',
        asyncRoute(async (_req, res) => {
            const {
                id,
                browser,
                displayNum,
                vncPort,
                novncPort,
                password,
                novncUrl
            } = await createBrowser();

            res.json({
                success: true,
                data: {
                    browserId: id,
                    displayNum: displayNum,
                    vncPort: vncPort,
                    novncPort: novncPort,
                    password: password,
                    novncUrl: novncUrl,
                    vncConnection: {
                        host: 'localhost',
                        port: vncPort,
                        password: password
                    },
                    novncConnection: {
                        url: novncUrl,
                        port: novncPort,
                        password: password
                    },
                }
            });
        })
    );

    app.get(
        '/api/browser',
        asyncRoute(async (_req, res) => {
            res.json({ browsers: listBrowsers() });
        })
    );

    app.get(
        '/api/browsers',
        asyncRoute(async (_req, res) => {
            res.json({ browsers: listBrowsers() });
        })
    );

    app.delete(
        '/api/browser',
        asyncRoute(async (_req, res) => {
            res.json(await closeAllBrowsers());
        })
    );

    app.delete(
        '/api/browsers',
        asyncRoute(async (_req, res) => {
            res.json(await closeAllBrowsers());
        })
    );

    app.get(
        '/api/browser/:id',
        asyncRoute(async (req, res) => {
            res.json(getBrowserInfo(req.params.id));
        })
    );

    app.delete(
        '/api/browser/:id',
        asyncRoute(async (req, res) => {
            await closeBrowser(req.params.id);
            res.json({ message: 'Browser closed' });
        })
    );

    /* -------------------------------- pages ------------------------------- */
    app.post(
        '/api/browser/:id/page',
        asyncRoute(async (req, res) => {
            const { id } = await newPage(req.params.id);
            res.json({ message: 'Page created', pageId: id });
        })
    );

    app.get(
        '/api/browser/:id/pages',
        asyncRoute(async (req, res) => {
            res.json({ pages: listPages(req.params.id) });
        })
    );

    app.get(
        '/api/pages',
        asyncRoute(async (_req, res) => {
            res.json({ pages: listPages() });
        })
    );

    app.get(
        '/api/page/:pageId',
        asyncRoute(async (req, res) => {
            res.json(await getPageInfo(req.params.pageId));
        })
    );

    app.delete(
        '/api/page/:pageId',
        asyncRoute(async (req, res) => {
            await closePage(req.params.pageId);
            res.json({ message: 'Page closed' });
        })
    );

    /* ----------------------------- navigation ----------------------------- */
    app.post(
        '/api/page/:pageId/goto',
        asyncRoute(async (req, res) => {
            res.json(
                await goto(req.params.pageId, req.body?.url, req.body || {})
            );
        })
    );

    app.post(
        '/api/page/:pageId/back',
        asyncRoute(async (req, res) => {
            res.json(await goBack(req.params.pageId, req.body || {}));
        })
    );

    app.post(
        '/api/page/:pageId/forward',
        asyncRoute(async (req, res) => {
            res.json(await goForward(req.params.pageId, req.body || {}));
        })
    );

    app.post(
        '/api/page/:pageId/reload',
        asyncRoute(async (req, res) => {
            res.json(await reload(req.params.pageId, req.body || {}));
        })
    );

    /* -------------------------------- waits ------------------------------- */
    app.post(
        '/api/page/:pageId/wait/selector',
        asyncRoute(async (req, res) => {
            res.json(
                await waitForSelector(
                    req.params.pageId,
                    req.body?.selector,
                    req.body || {}
                )
            );
        })
    );

    app.post(
        '/api/page/:pageId/wait/url',
        asyncRoute(async (req, res) => {
            res.json(
                await waitForURL(req.params.pageId, req.body?.url, req.body || {})
            );
        })
    );

    app.post(
        '/api/page/:pageId/wait/load-state',
        asyncRoute(async (req, res) => {
            res.json(
                await waitForLoadState(
                    req.params.pageId,
                    req.body?.state || 'load',
                    req.body || {}
                )
            );
        })
    );

    app.post(
        '/api/page/:pageId/wait/network-idle',
        asyncRoute(async (req, res) => {
            res.json(await waitForNetworkIdle(req.params.pageId, req.body || {}));
        })
    );

    /* -------------------------------- actions ----------------------------- */
    app.post(
        '/api/page/:pageId/click',
        asyncRoute(async (req, res) => {
            res.json(
                await click(req.params.pageId, req.body?.selector, req.body || {})
            );
        })
    );

    app.post(
        '/api/page/:pageId/click-text',
        asyncRoute(async (req, res) => {
            res.json(
                await clickText(req.params.pageId, req.body?.text, req.body || {})
            );
        })
    );

    app.post(
        '/api/page/:pageId/click-role',
        asyncRoute(async (req, res) => {
            res.json(
                await clickRole(req.params.pageId, req.body?.role, req.body || {})
            );
        })
    );

    app.post(
        '/api/page/:pageId/fill',
        asyncRoute(async (req, res) => {
            res.json(
                await fill(
                    req.params.pageId,
                    req.body?.selector,
                    req.body?.value,
                    req.body || {}
                )
            );
        })
    );

    app.post(
        '/api/page/:pageId/fill-by-label',
        asyncRoute(async (req, res) => {
            res.json(
                await fillByLabel(
                    req.params.pageId,
                    req.body?.label,
                    req.body?.value,
                    req.body || {}
                )
            );
        })
    );

    app.post(
        '/api/page/:pageId/press',
        asyncRoute(async (req, res) => {
            res.json(
                await press(
                    req.params.pageId,
                    req.body?.selector,
                    req.body?.key,
                    req.body || {}
                )
            );
        })
    );

    app.post(
        '/api/page/:pageId/select',
        asyncRoute(async (req, res) => {
            res.json(
                await selectOption(
                    req.params.pageId,
                    req.body?.selector,
                    req.body?.values,
                    req.body || {}
                )
            );
        })
    );

    app.post(
        '/api/page/:pageId/select-by-label',
        asyncRoute(async (req, res) => {
            res.json(
                await selectByLabel(
                    req.params.pageId,
                    req.body?.label,
                    req.body?.values,
                    req.body || {}
                )
            );
        })
    );
}