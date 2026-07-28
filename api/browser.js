import { chromium } from 'patchright';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
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

const userDataDir = "./chromeData"

// Chrome only allows ONE live process per profile dir (SingletonLock), so
// concurrent windows each need their own profile directory. Instead of a
// fresh throwaway dir per browser (loses history every time) or one truly
// shared dir (impossible while >1 window is open), we keep a small pool of
// real, on-disk profile dirs and check them out round-robin. Each slot keeps
// accumulating its own genuine history/cache/cookies across every reuse —
// no copying, no merge logic, just "pick a free chair."
const PROFILE_POOL_SIZE = Number(process.env.BROWSER_PROFILE_POOL_SIZE) || 4;

const busyProfileSlots = new Set(); // slot indices currently checked out
let nextOverflowSlot = PROFILE_POOL_SIZE;

// Files Chrome writes per-run to enforce its single-instance lock. If our
// own process tracking says a slot is free, any of these left over from an
// unclean shutdown are stale and safe to clear before relaunching into it.
const SINGLETON_LOCK_FILES = [
    'SingletonLock',
    'SingletonSocket',
    'SingletonCookie',
    'lockfile',
];

function profileDirForSlot(slot) {
    return path.join(userDataDir, `profile-${slot}`);
}

async function clearStaleLockFiles(profileDir) {
    await Promise.all(
        SINGLETON_LOCK_FILES.map((name) =>
            fs.rm(path.join(profileDir, name), { force: true }).catch(() => {})
        )
    );
}

// Reserve a slot and clear any stale lock files left over from a crash.
async function acquireProfileSlot() {
    let slot = -1;
    for (let i = 0; i < PROFILE_POOL_SIZE; i++) {
        if (!busyProfileSlots.has(i)) {
            slot = i;
            break;
        }
    }
    if (slot === -1) {
        // Pool exhausted — shouldn't normally happen at your usage levels,
        // but grow rather than fail outright.
        slot = nextOverflowSlot++;
        console.warn(
            `Profile pool exhausted (size ${PROFILE_POOL_SIZE}); allocating overflow slot ${slot}`
        );
    }
    busyProfileSlots.add(slot);
    const profileDir = profileDirForSlot(slot);
    await fs.mkdir(profileDir, { recursive: true });
    await clearStaleLockFiles(profileDir);
    return { slot, profileDir };
}

function releaseProfileSlot(slot) {
    busyProfileSlots.delete(slot);
}

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
    '--start-maximized',
];

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
    if (entry.profileSlot !== undefined) releaseProfileSlot(entry.profileSlot);
    browsers.delete(entry.id);
}

async function closeIdleBrowser(entry) {
    if (!entry) return;
    try {
        if (entry.connected) {
            await entry.context.close();
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

    // Check out a real, reusable profile dir from the pool rather than a
    // one-off dir keyed on this random id — that's what lets it keep a
    // continuous cache/cookie/history/extension footprint across runs.
    const { slot, profileDir } = await acquireProfileSlot();

    let context;
    try {
        context = await chromium.launchPersistentContext(profileDir, {
            headless: false,
            args: LAUNCH_ARGS,
            env: {
                ...process.env,
                DISPLAY: `:${displayNum}`
            },
            executablePath: '/usr/bin/chromium',

            // context-level (anti-detection) options merged into the same call,
            // since launchPersistentContext launches the browser AND creates
            // the one-and-only context in a single step.
            viewport: null,
            locale: REALISTIC_LOCALE,
            timezoneId: REALISTIC_TIMEZONE,
            hasTouch: false,
            isMobile: false,
            javaScriptEnabled: true,
            colorScheme: 'light',
        });

        /* -------------------- worker navigator consistency -------------------- */
        await context.addInitScript(() => {
            const patch = (() => {
                const props = {
                    language: navigator.language,
                    languages: navigator.languages,
                    platform: navigator.platform,
                    vendor: navigator.vendor,
                    hardwareConcurrency: navigator.hardwareConcurrency,
                    userAgent: navigator.userAgent,
                    webdriver: navigator.webdriver,
                };
                for (const [k, v] of Object.entries(props)) {
                    try {
                        Object.defineProperty(navigator, k, {
                            get: () => v,
                            configurable: true,
                            enumerable: true,
                        });
                    } catch (e) {}
                }
            }).toString();

            const patchCode = `(${patch})();`;

            function wrapWorker(OriginalWorker) {
                return function (scriptURL, options) {
                    const url = scriptURL instanceof URL ? scriptURL.href : String(scriptURL);
                    try {
                        const parsed = new URL(url, location.href);
                        const isBlob = parsed.protocol === 'blob:';
                        const isSameOrigin = parsed.origin === location.origin;

                        if (isBlob || isSameOrigin) {
                            const xhr = new XMLHttpRequest();
                            xhr.open('GET', url, false);
                            xhr.send();
                            const wrapped = patchCode + '\n' + xhr.responseText;
                            const blob = new Blob([wrapped], { type: 'application/javascript' });
                            const blobUrl = URL.createObjectURL(blob);
                            return new OriginalWorker(blobUrl, options);
                        }
                    } catch (e) {
                        // If anything fails (CSP, cross-origin, etc.) fall back to native.
                    }
                    return new OriginalWorker(scriptURL, options);
                };
            }

            window.Worker = wrapWorker(window.Worker);
            if (window.SharedWorker) {
                window.SharedWorker = wrapWorker(window.SharedWorker);
            }
        });
    } catch (err) {
        releaseProfileSlot(slot);
        await displayManager.cleanupDisplay(displayNum).catch(() => {});
        throw err;
    }

    const defaultContextId = `default-${id}`;
    const contextEntry = {
        id: defaultContextId,
        browserId: id,
        context,
        pages: new Map(),
        createdAt: new Date().toISOString(),
    };

    const entry = {
        id,
        context,          // persistent context doubles as the "browser" handle
        connected: true,
        profileDir,
        profileSlot: slot,
        displayNum,
        vncPort,
        novncPort,
        password,
        contexts: new Map([[defaultContextId, contextEntry]]),
        pages: new Map(),
        createdAt: new Date().toISOString(),
        lastUsedAt: Date.now(),
        idleTimeoutMs: toIdleTimeout(undefined),
    };

    browsers.set(id, entry);
    contexts.set(defaultContextId, contextEntry);

    // launchPersistentContext has no separate Browser object, so 'close' on
    // the context is the equivalent of the old 'disconnected' event.
    context.on('close', async () => {
        console.log(`Browser ${id} closed, cleaning up display :${displayNum}`);
        entry.connected = false;
        releaseProfileSlot(slot);

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
        context,
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
    await entry.context.close();
    browsers.delete(id);
}

export async function closeAllBrowsers() {
    const ids = [...browsers.keys()];
    await Promise.allSettled(
        ids.map((id) => browsers.get(id)?.context.close())
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
        connected: entry.connected,
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
        connected: entry.connected,
        pages: [...entry.pages.values()].map(safePageSummary),
    };
}

/* ----------------------------- context APIs ----------------------------- */

// NOTE: a launched persistent context IS the browser process — Chromium
// doesn't support multiple isolated profiles inside one launchPersistentContext
// call, so there's exactly one context per browserId, already created in
// createBrowser(). This just looks it up.
async function getOrCreateDefaultContext(browserId) {
    const browserEntry = getBrowserEntry(browserId);
    const defaultId = `default-${browserId}`;
    const contextEntry = browserEntry.contexts.get(defaultId);
    if (!contextEntry) {
        throw notFound(`Default context for browser "${browserId}" not found`);
    }
    return contextEntry;
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