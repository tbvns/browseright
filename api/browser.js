import { chromium } from 'patchright';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const browsers = new Map();
const contexts = new Map();
const pages = new Map();

const DEFAULT_TIMEOUT = 30_000;
const MAX_LOGS = 1_000;

const DEFAULT_IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours
const IDLE_CLEANUP_DEFAULT_INTERVAL_MS = 60 * 1000; // check every minute

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
const clampLimit = (limit = 100) =>
    Math.max(1, Math.min(Number(limit) || 100, MAX_LOGS));

function pushLog(arr, item) {
    arr.push(item);
    if (arr.length > MAX_LOGS) arr.splice(0, arr.length - MAX_LOGS);
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchUrl(url, pattern) {
    if (pattern instanceof RegExp) return pattern.test(url);
    if (typeof pattern !== 'string') return false;
    if (pattern === '*') return true;

    if (pattern.includes('*')) {
        const rx = new RegExp(
            `^${pattern.split('*').map(escapeRegExp).join('.*')}$`
        );
        return rx.test(url);
    }

    return url.includes(pattern);
}

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

function normalizeFiles(files) {
    if (!files) return [];

    const list = Array.isArray(files) ? files : [files];

    return list.map((file) => {
        if (typeof file === 'string') return file;
        if (file?.path) return file.path;

        if (file?.base64) {
            return {
                name: file.name || 'upload',
                mimeType: file.mimeType || 'application/octet-stream',
                buffer: Buffer.from(file.base64, 'base64'),
            };
        }

        return file;
    });
}

function safePageSummary(entry) {
    return {
        id: entry.id,
        browserId: entry.browserId,
        contextId: entry.contextId,
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

    // Throttle automatic event-based touches.
    // Explicit API access can use force = true.
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

    // timeout === 0 disables idle closing
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
        if (!entry.browser?.isConnected || entry.browser.isConnected()) {
            await entry.browser?.close();
        }
    } catch {
        // Best effort only.
        // Force cleanup below removes stale references.
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

    // Prevent the timer from keeping the Node process alive in tests/serverless.
    idleCleanupTimer.unref?.();
}

export function stopIdleBrowserCleanup() {
    if (idleCleanupTimer) {
        clearInterval(idleCleanupTimer);
        idleCleanupTimer = null;
    }
}

startIdleBrowserCleanup();

function contextForPage(pageEntry) {
    const ctx = contexts.get(pageEntry.contextId);
    if (!ctx) throw notFound('Context for page not found');

    touchBrowser(pageEntry.browserId, true);

    return ctx.context;
}

async function navResult(page) {
    return {
        url: page.url(),
        title: await page.title().catch(() => ''),
    };
}

async function serializeElementHandle(page, handle) {
    if (!handle) return { found: false };

    const info = await handle
        .evaluate((el) => {
            const rect = el.getBoundingClientRect();

            return {
                tagName: el.tagName?.toLowerCase?.() || null,
                text: 'innerText' in el ? el.innerText : el.textContent,
                value: 'value' in el ? el.value : null,
                attributes: Object.fromEntries(
                    [...(el.attributes || [])].map((a) => [a.name, a.value])
                ),
                boundingBox: {
                    x: rect.x,
                    y: rect.y,
                    width: rect.width,
                    height: rect.height,
                    top: rect.top,
                    right: rect.right,
                    bottom: rect.bottom,
                    left: rect.left,
                },
                visible: !!(
                    el.offsetWidth ||
                    el.offsetHeight ||
                    el.getClientRects?.().length
                ),
            };
        })
        .catch(() => null);

    return { found: true, ...info };
}

async function extractLocatorFields(locator, def) {
    const out = {};

    if (def.text) out.text = await locator.innerText().catch(() => null);
    if (def.textContent)
        out.textContent = await locator.textContent().catch(() => null);
    if (def.html) out.html = await locator.innerHTML().catch(() => null);
    if (def.value) out.value = await locator.inputValue().catch(() => null);
    if (def.attribute)
        out.attribute = await locator.getAttribute(def.attribute).catch(() => null);

    if (Array.isArray(def.attributes)) {
        for (const attr of def.attributes) {
            out[attr] = await locator.getAttribute(attr).catch(() => null);
        }
    }

    if (def.boundingBox) {
        out.boundingBox = await locator.boundingBox().catch(() => null);
    }

    if (Object.keys(out).length === 0) {
        out.text = await locator.innerText().catch(() => null);
        out.href = await locator.getAttribute('href').catch(() => null);
    }

    return out;
}

async function ensureRouting(pageEntry) {
    if (pageEntry.routeInstalled) return;

    pageEntry.routeInstalled = true;

    await pageEntry.page.route('**/*', async (route) => {
        try {
            const request = route.request();
            const url = request.url();
            const resourceType = request.resourceType();

            if (pageEntry.blockResourceTypes.includes(resourceType)) {
                return await route.abort('blockedbyclient');
            }

            const rules = [...pageEntry.routeRules].reverse();

            for (const rule of rules) {
                if (!matchUrl(url, rule.urlPattern)) continue;
                if (rule.resourceTypes && !rule.resourceTypes.includes(resourceType)) {
                    continue;
                }

                if (rule.action === 'abort') {
                    return await route.abort(rule.errorCode || 'failed');
                }

                if (rule.action === 'fulfill') {
                    const headers = rule.headers || {};

                    if (
                        rule.contentType &&
                        !headers['content-type'] &&
                        !headers['Content-Type']
                    ) {
                        headers['content-type'] = rule.contentType;
                    }

                    const body = rule.bodyBase64
                        ? Buffer.from(rule.bodyBase64, 'base64')
                        : rule.body ?? '';

                    return await route.fulfill({
                        status: rule.status || 200,
                        headers,
                        body,
                    });
                }

                if (rule.action === 'continue') {
                    const overrides = {};

                    if (rule.url) overrides.url = rule.url;
                    if (rule.method) overrides.method = rule.method;
                    if (rule.headers) overrides.headers = rule.headers;
                    if (rule.postData) overrides.postData = rule.postData;

                    return await route.continue(overrides);
                }
            }

            return await route.continue();
        } catch {
            return await route.continue().catch(() => {});
        }
    });
}

function attachPage(pageId, page, browserId, contextId, options = {}) {
    if (pages.has(pageId)) throw badRequest(`Page id "${pageId}" already exists`);

    const pageEntry = {
        id: pageId,
        browserId,
        contextId,
        page,
        console: [],
        requests: [],
        responses: [],
        downloads: [],
        dialogs: [],
        routeRules: [],
        blockResourceTypes: [],
        routeInstalled: false,
        dialogHandler: {
            action: 'dismiss',
            promptText: '',
        },
        autoSaveDownloads: options.autoSaveDownloads ?? false,
        downloadDir: options.downloadDir || null,
        createdAt: new Date().toISOString(),
    };

    page.setDefaultTimeout(toTimeout(options.timeout));

    page.on('console', (msg) => {
        pushLog(pageEntry.console, {
            type: msg.type(),
            text: msg.text(),
            location: msg.location(),
            time: Date.now(),
        });
    });

    page.on('pageerror', (error) => {
        pushLog(pageEntry.console, {
            type: 'pageerror',
            text: error?.message || String(error),
            stack: error?.stack,
            time: Date.now(),
        });
    });

    page.on('request', (request) => {
        pushLog(pageEntry.requests, {
            url: request.url(),
            method: request.method(),
            resourceType: request.resourceType(),
            postData: request.postData() ?? null,
            headers: request.headers(),
            time: Date.now(),
        });
    });

    page.on('response', (response) => {
        pushLog(pageEntry.responses, {
            url: response.url(),
            status: response.status(),
            statusText: response.statusText(),
            headers: response.headers(),
            time: Date.now(),
        });
    });

    page.on('dialog', async (dialog) => {
        const record = {
            type: dialog.type(),
            message: dialog.message(),
            defaultValue: dialog.defaultValue(),
            handledAt: Date.now(),
        };

        pushLog(pageEntry.dialogs, record);

        try {
            if (pageEntry.dialogHandler.action === 'accept') {
                await dialog.accept(
                    pageEntry.dialogHandler.promptText ?? record.defaultValue
                );
                record.handled = 'accept';
            } else {
                await dialog.dismiss();
                record.handled = 'dismiss';
            }
        } catch (err) {
            record.error = err.message;
        }
    });

    page.on('download', async (download) => {
        const downloadId = toId();

        const item = {
            id: downloadId,
            url: download.url(),
            suggestedFilename: download.suggestedFilename(),
            state: 'in-progress',
            startedAt: Date.now(),
        };

        pushLog(pageEntry.downloads, item);

        try {
            if (pageEntry.autoSaveDownloads) {
                const dir =
                    pageEntry.downloadDir ||
                    path.join(os.tmpdir(), 'ai-browser-agent', pageId);

                await fs.mkdir(dir, { recursive: true });

                const filePath = path.join(
                    dir,
                    item.suggestedFilename || downloadId
                );

                await download.saveAs(filePath);
                item.path = filePath;
                item.state = 'saved';
            } else {
                item.state = 'available';
            }
        } catch (err) {
            item.state = 'error';
            item.error = err.message;
        }
    });

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

export async function createBrowser(browserId = null, options = {}) {
    const id = toId(browserId);

    if (browsers.has(id)) {
        throw badRequest(`Browser with id "${id}" already exists`);
    }

    const browser = await chromium.launch({
        headless: options.headless ?? false,
        ignoreDefaultArgs: ['--no-startup-window'],
        args: options.args ?? [],
        ...(options.executablePath ? { executablePath: options.executablePath } : {}),
        ...(options.proxy ? { proxy: options.proxy } : {}),
        ...(options.launchOptions ?? {}),
    });

    const entry = {
        id,
        browser,
        contexts: new Map(),
        pages: new Map(),
        createdAt: new Date().toISOString(),
        lastUsedAt: Date.now(),
        idleTimeoutMs: toIdleTimeout(options.idleTimeoutMs),
    };

    browsers.set(id, entry);

    browser.on('disconnected', () => {
        for (const contextEntry of [...entry.contexts.values()]) {
            removeContextEntry(contextEntry);
        }

        for (const pageEntry of [...entry.pages.values()]) {
            removePageEntry(pageEntry);
        }

        browsers.delete(id);
    });

    return { id, browser };
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
        contexts: [...entry.contexts.keys()],
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
        contexts: [...entry.contexts.values()].map((ctx) => ({
            id: ctx.id,
            pages: [...ctx.pages.keys()],
            createdAt: ctx.createdAt,
        })),
        pages: [...entry.pages.values()].map(safePageSummary),
    };
}

/* ----------------------------- context APIs ----------------------------- */

export async function createContext(browserId, options = {}) {
    const browserEntry = getBrowserEntry(browserId);
    const id = toId(options.contextId);

    if (contexts.has(id)) {
        throw badRequest(`Context with id "${id}" already exists`);
    }

    const context = await browserEntry.browser.newContext({
        acceptDownloads: options.acceptDownloads ?? true,
        ...(options.userAgent ? { userAgent: options.userAgent } : {}),
        ...(options.viewport ? { viewport: options.viewport } : {}),
        ...(options.locale ? { locale: options.locale } : {}),
        ...(options.timezoneId ? { timezoneId: options.timezoneId } : {}),
        ...(options.geolocation ? { geolocation: options.geolocation } : {}),
        ...(options.permissions ? { permissions: options.permissions } : {}),
        ...(options.storageState ? { storageState: options.storageState } : {}),
        ...(options.colorScheme ? { colorScheme: options.colorScheme } : {}),
        ...(options.deviceScaleFactor
            ? { deviceScaleFactor: options.deviceScaleFactor }
            : {}),
        ...(options.hasTouch ? { hasTouch: options.hasTouch } : {}),
        ...(options.isMobile ? { isMobile: options.isMobile } : {}),
        ...(options.ignoreHTTPSErrors
            ? { ignoreHTTPSErrors: options.ignoreHTTPSErrors }
            : {}),
        ...(options.contextOptions ?? {}),
    });

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

    return { id };
}

export function getContextEntry(id) {
    const entry = contexts.get(id);
    if (!entry) throw notFound(`Context with id "${id}" not found`);
    return entry;
}

export async function closeContext(contextId) {
    const entry = getContextEntry(contextId);
    await entry.context.close();
    removeContextEntry(entry);
}

async function getOrCreateDefaultContext(browserId) {
    const browserEntry = getBrowserEntry(browserId);
    const defaultId = `default-${browserId}`;

    let contextEntry = browserEntry.contexts.get(defaultId);
    if (contextEntry) return contextEntry;

    await createContext(browserId, {
        contextId: defaultId,
        acceptDownloads: true,
    });

    return browserEntry.contexts.get(defaultId);
}

/* ------------------------------- page APIs ------------------------------ */

export async function newPage(browserId, options = {}) {
    const contextEntry = options.contextId
        ? getContextEntry(options.contextId)
        : await getOrCreateDefaultContext(browserId);

    if (options.contextId && contextEntry.browserId !== browserId) {
        throw badRequest('Context does not belong to this browser');
    }

    const page = await contextEntry.context.newPage();

    if (options.viewport) {
        await page.setViewportSize(options.viewport).catch(() => {});
    }

    const pageId = toId(options.pageId);
    attachPage(pageId, page, browserId, contextEntry.id, options);

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

export async function bringToFront(pageId) {
    return withPage(pageId, async (page) => {
        await page.bringToFront();
        return { ok: true };
    });
}

/* ----------------------------- navigation ------------------------------- */

export async function goto(pageId, url, options = {}) {
    if (!url) throw badRequest('url is required');

    return withPage(pageId, async (page) => {
        const response = await page.goto(url, {
            timeout: toTimeout(options.timeout),
            waitUntil: options.waitUntil ?? 'load',
            ...(options.referer ? { referer: options.referer } : {}),
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

        if (!handle) {
            return {
                found: true,
                state: options.state ?? 'visible',
                element: null,
            };
        }

        const element = await serializeElementHandle(page, handle).catch(() => null);
        await handle.dispose().catch(() => {});

        return {
            found: true,
            element,
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

export async function waitForFunction(pageId, script, arg, options = {}) {
    if (!script) throw badRequest('script is required');

    return withPage(pageId, async (page) => {
        let handle;

        if (options.mode === 'function') {
            const fn = new Function('arg', `return (${script})(arg);`);
            handle = await page.waitForFunction(fn, arg, {
                timeout: toTimeout(options.timeout),
                polling: options.polling,
            });
        } else {
            handle = await page.waitForFunction(script, arg, {
                timeout: toTimeout(options.timeout),
                polling: options.polling,
            });
        }

        const value = await handle.jsonValue().catch(() => null);
        await handle.dispose?.().catch(() => {});

        return { ok: true, value };
    });
}

export async function waitForTimeout(pageId, ms = 1000) {
    const delay = Number(ms) || 1000;

    return withPage(pageId, async (page) => {
        await page.waitForTimeout(delay);
        return { ok: true, ms: delay };
    });
}

export async function waitForRequest(pageId, urlPattern, options = {}) {
    if (!urlPattern) throw badRequest('urlPattern is required');

    return withPage(pageId, async (page) => {
        const request = await page.waitForRequest(
            (req) => matchUrl(req.url(), urlPattern),
            {
                timeout: toTimeout(options.timeout),
            }
        );

        return {
            url: request.url(),
            method: request.method(),
            resourceType: request.resourceType(),
            postData: request.postData() ?? null,
        };
    });
}

export async function waitForResponse(pageId, urlPattern, options = {}) {
    if (!urlPattern) throw badRequest('urlPattern is required');

    return withPage(pageId, async (page) => {
        const response = await page.waitForResponse(
            (res) => matchUrl(res.url(), urlPattern),
            {
                timeout: toTimeout(options.timeout),
            }
        );

        return {
            url: response.url(),
            status: response.status(),
            statusText: response.statusText(),
        };
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

export async function getTitle(pageId) {
    return withPage(pageId, async (page) => ({
        title: await page.title().catch(() => ''),
    }));
}

export async function getUrl(pageId) {
    return withPage(pageId, async (page) => ({
        url: page.url(),
    }));
}

export async function getContent(pageId) {
    return withPage(pageId, async (page) => page.content());
}

export async function setContent(pageId, html, options = {}) {
    if (typeof html !== 'string') throw badRequest('html must be a string');

    return withPage(pageId, async (page) => {
        await page.setContent(html, {
            timeout: toTimeout(options.timeout),
            waitUntil: options.waitUntil ?? 'load',
        });

        return await navResult(page);
    });
}

export async function getBodyText(pageId) {
    return withPage(pageId, async (page) =>
        page
            .locator('body')
            .innerText()
            .catch(() => '')
    );
}

export async function getMarkdown(pageId) {
    return withPage(pageId, async (page) => {
        return page.evaluate(() => {
            if (!document.body) return '';

            const clean = (s) => s.replace(/\s+/g, ' ').trim();

            const walk = (node) => {
                if (node.nodeType === 3) return clean(node.nodeValue || '');
                if (node.nodeType !== 1) return '';

                const el = node;
                const tag = el.tagName;

                if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG'].includes(tag)) {
                    return '';
                }

                const children = Array.from(el.childNodes)
                    .map(walk)
                    .filter(Boolean)
                    .join(' ');

                switch (tag) {
                    case 'H1':
                        return `# ${children}\n\n`;
                    case 'H2':
                        return `## ${children}\n\n`;
                    case 'H3':
                        return `### ${children}\n\n`;
                    case 'H4':
                        return `#### ${children}\n\n`;
                    case 'H5':
                        return `##### ${children}\n\n`;
                    case 'H6':
                        return `###### ${children}\n\n`;
                    case 'P':
                        return children ? `${children}\n\n` : '';
                    case 'BR':
                        return '\n';
                    case 'LI':
                        return `- ${children}\n`;
                    case 'UL':
                    case 'OL':
                        return `${children}\n`;
                    case 'A':
                        return `[${children}](${el.getAttribute('href') || ''})`;
                    case 'IMG':
                        return `![${el.getAttribute('alt') || ''}](${
                            el.getAttribute('src') || ''
                        })`;
                    case 'BUTTON':
                    case 'LABEL':
                    case 'SPAN':
                        return children;
                    case 'DIV':
                    case 'SECTION':
                    case 'ARTICLE':
                    case 'MAIN':
                    case 'HEADER':
                    case 'FOOTER':
                        return children ? `${children}\n` : '';
                    default:
                        return children;
                }
            };

            return walk(document.body).replace(/\n{3,}/g, '\n\n').trim();
        });
    });
}

export async function getAccessibilitySnapshot(pageId, options = {}) {
    return withPage(pageId, async (page) => {
        return page
            .accessibility.snapshot({
                interestingOnly: options.interestingOnly ?? true,
            })
            .catch(() => null);
    });
}

export async function agentSnapshot(pageId, options = {}) {
    return withPage(pageId, async (page) => {
        const [title, url, html, accessibility, text, links, inputs, buttons] =
            await Promise.all([
                page.title().catch(() => ''),
                Promise.resolve(page.url()),
                page.content().catch(() => ''),
                page
                    .accessibility.snapshot({ interestingOnly: true })
                    .catch(() => null),
                page
                    .locator('body')
                    .innerText()
                    .catch(() => ''),
                page
                    .locator('a')
                    .evaluateAll((els) =>
                        els.slice(0, 200).map((a) => ({
                            text: (a.innerText || a.textContent || '').trim().slice(0, 200),
                            href: a.href,
                        }))
                    )
                    .catch(() => []),
                page
                    .locator('input, textarea, select')
                    .evaluateAll((els) =>
                        els.slice(0, 200).map((el) => ({
                            tag: el.tagName.toLowerCase(),
                            type: el.getAttribute('type') || null,
                            name: el.getAttribute('name') || null,
                            id: el.id || null,
                            placeholder: el.getAttribute('placeholder') || null,
                            label: el.getAttribute('aria-label') || null,
                            value: 'value' in el ? el.value : null,
                        }))
                    )
                    .catch(() => []),
                page
                    .locator('button, [role="button"], input[type="button"], input[type="submit"]')
                    .evaluateAll((els) =>
                        els.slice(0, 200).map((el) => ({
                            tag: el.tagName.toLowerCase(),
                            text: (
                                el.innerText ||
                                el.value ||
                                el.getAttribute('aria-label') ||
                                ''
                            )
                                .trim()
                                .slice(0, 200),
                            id: el.id || null,
                            name: el.getAttribute('name') || null,
                        }))
                    )
                    .catch(() => []),
            ]);

        return {
            title,
            url,
            text: text.slice(0, options.textLimit ?? 20_000),
            accessibility,
            links,
            inputs,
            buttons,
            htmlLength: html.length,
        };
    });
}

/* ------------------------------ evaluation ------------------------------ */

export async function evaluate(pageId, script, arg, options = {}) {
    if (!script) throw badRequest('script is required');

    return withPage(pageId, async (page) => {
        if (options.mode === 'function') {
            const fn = new Function('arg', `return (${script})(arg);`);
            return await page.evaluate(fn, arg);
        }

        return await page.evaluate(script, arg);
    });
}

export async function evaluateInFrame(pageId, script, arg, options = {}) {
    if (!script) throw badRequest('script is required');

    return withPage(pageId, async (page) => {
        let frame;

        if (Number.isFinite(options.index)) {
            frame = page.frames()[options.index];
        } else if (options.name) {
            frame = page.frame({ name: options.name });
        } else if (options.url) {
            frame = page.frames().find((f) => matchUrl(f.url(), options.url));
        } else {
            frame = page.mainFrame();
        }

        if (!frame) throw notFound('Frame not found');

        if (options.mode === 'function') {
            const fn = new Function('arg', `return (${script})(arg);`);
            return await frame.evaluate(fn, arg);
        }

        return await frame.evaluate(script, arg);
    });
}

export async function extract(pageId, spec = {}) {
    return withPage(pageId, async (page) => {
        const out = {};

        for (const [key, def] of Object.entries(spec)) {
            if (!def || typeof def !== 'object') continue;

            if (def.all) {
                const locator = page.locator(def.selector);
                const count = await locator.count();
                const limit = Math.min(count, clampLimit(def.limit ?? 100));
                const items = [];

                for (let i = 0; i < limit; i++) {
                    const itemLocator = locator.nth(i);
                    items.push(await extractLocatorFields(itemLocator, def.fields ?? def));
                }

                out[key] = items;
            } else {
                const locator = page.locator(def.selector).first();
                out[key] = await extractLocatorFields(locator, def.fields ?? def).catch(
                    () => null
                );
            }
        }

        return out;
    });
}

/* ------------------------------- queries -------------------------------- */

export async function getElement(pageId, selector, options = {}) {
    if (!selector) throw badRequest('selector is required');

    return withPage(pageId, async (page) => {
        const handle = await page.$(selector);
        if (!handle) return { found: false };

        const element = await serializeElementHandle(page, handle);
        await handle.dispose().catch(() => {});

        return element;
    });
}

export async function getElements(pageId, selector, options = {}) {
    if (!selector) throw badRequest('selector is required');

    return withPage(pageId, async (page) => {
        const handles = await page.$$(selector);
        const limit = clampLimit(options.limit ?? 100);
        const elements = [];

        for (const handle of handles.slice(0, limit)) {
            const element = await serializeElementHandle(page, handle).catch(
                () => null
            );

            if (element) elements.push(element);
            await handle.dispose().catch(() => {});
        }

        return {
            count: handles.length,
            elements,
        };
    });
}

export async function count(pageId, selector) {
    if (!selector) throw badRequest('selector is required');

    return withPage(pageId, async (page) => ({
        selector,
        count: await page.locator(selector).count(),
    }));
}

export async function getText(pageId, selector, options = {}) {
    if (!selector) throw badRequest('selector is required');

    return withPage(pageId, async (page) => {
        const locator = page.locator(selector).first();
        const exists = await page.locator(selector).count();

        if (!exists) {
            return { selector, text: null };
        }

        const text = await locator
            .innerText({ timeout: toTimeout(options.timeout) })
            .catch(async () =>
                locator.textContent({ timeout: toTimeout(options.timeout) })
            );

        return { selector, text };
    });
}

export async function getInnerHTML(pageId, selector, options = {}) {
    if (!selector) throw badRequest('selector is required');

    return withPage(pageId, async (page) => {
        const exists = await page.locator(selector).count();
        if (!exists) return { selector, html: null };

        const html = await page
            .locator(selector)
            .first()
            .innerHTML({ timeout: toTimeout(options.timeout) });

        return { selector, html };
    });
}

export async function getAttribute(pageId, selector, attribute, options = {}) {
    if (!selector) throw badRequest('selector is required');
    if (!attribute) throw badRequest('attribute is required');

    return withPage(pageId, async (page) => {
        const exists = await page.locator(selector).count();
        if (!exists) return { selector, attribute, value: null };

        const value = await page
            .locator(selector)
            .first()
            .getAttribute(attribute, { timeout: toTimeout(options.timeout) });

        return { selector, attribute, value };
    });
}

export async function getValue(pageId, selector, options = {}) {
    if (!selector) throw badRequest('selector is required');

    return withPage(pageId, async (page) => {
        const exists = await page.locator(selector).count();
        if (!exists) return { selector, value: null };

        const value = await page
            .locator(selector)
            .first()
            .inputValue({ timeout: toTimeout(options.timeout) })
            .catch(() => null);

        return { selector, value };
    });
}

export async function isVisible(pageId, selector) {
    if (!selector) throw badRequest('selector is required');

    return withPage(pageId, async (page) => {
        const exists = await page.locator(selector).count();
        if (!exists) return { selector, visible: false };

        const visible = await page.locator(selector).first().isVisible();
        return { selector, visible };
    });
}

export async function isEnabled(pageId, selector) {
    if (!selector) throw badRequest('selector is required');

    return withPage(pageId, async (page) => {
        const exists = await page.locator(selector).count();
        if (!exists) return { selector, enabled: false };

        const enabled = await page.locator(selector).first().isEnabled();
        return { selector, enabled };
    });
}

export async function isChecked(pageId, selector) {
    if (!selector) throw badRequest('selector is required');

    return withPage(pageId, async (page) => {
        const exists = await page.locator(selector).count();
        if (!exists) return { selector, checked: false };

        const checked = await page
            .locator(selector)
            .first()
            .isChecked()
            .catch(() => false);

        return { selector, checked };
    });
}

export async function getBoundingBox(pageId, selector) {
    if (!selector) throw badRequest('selector is required');

    return withPage(pageId, async (page) => {
        const exists = await page.locator(selector).count();
        if (!exists) return { selector, boundingBox: null };

        const boundingBox = await page.locator(selector).first().boundingBox();
        return { selector, boundingBox };
    });
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
                button: options.button,
                clickCount: options.clickCount,
                modifiers: options.modifiers,
                position: options.position,
                force: options.force,
                trial: options.trial,
                noWaitAfter: options.noWaitAfter,
            });

        return {
            clicked: selector,
            ...(await navResult(page).catch(() => ({}))),
        };
    });
}

export async function dblclick(pageId, selector, options = {}) {
    if (!selector) throw badRequest('selector is required');

    return withPage(pageId, async (page) => {
        await page
            .locator(selector)
            .first()
            .dblclick({
                timeout: toTimeout(options.timeout),
                button: options.button,
                modifiers: options.modifiers,
                position: options.position,
                force: options.force,
            });

        return { dblclicked: selector };
    });
}

export async function rightClick(pageId, selector, options = {}) {
    return click(pageId, selector, { ...options, button: 'right' });
}

export async function clickText(pageId, text, options = {}) {
    if (!text) throw badRequest('text is required');

    return withPage(pageId, async (page) => {
        await page
            .getByText(text, { exact: options.exact ?? false })
            .first()
            .click({
                timeout: toTimeout(options.timeout),
                button: options.button,
                force: options.force,
                trial: options.trial,
                modifiers: options.modifiers,
                position: options.position,
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
                checked: options.checked,
                disabled: options.disabled,
                expanded: options.expanded,
                includeHidden: options.includeHidden,
                level: options.level,
                pressed: options.pressed,
                selected: options.selected,
            })
            .first()
            .click({
                timeout: toTimeout(options.timeout),
                button: options.button,
                force: options.force,
                trial: options.trial,
            });

        return {
            clickedRole: role,
            ...(await navResult(page).catch(() => ({}))),
        };
    });
}

export async function hover(pageId, selector, options = {}) {
    if (!selector) throw badRequest('selector is required');

    return withPage(pageId, async (page) => {
        await page
            .locator(selector)
            .first()
            .hover({
                timeout: toTimeout(options.timeout),
                position: options.position,
                modifiers: options.modifiers,
                force: options.force,
            });

        return { hovered: selector };
    });
}

export async function focus(pageId, selector, options = {}) {
    if (!selector) throw badRequest('selector is required');

    return withPage(pageId, async (page) => {
        await page
            .locator(selector)
            .first()
            .focus({ timeout: toTimeout(options.timeout) });

        return { focused: selector };
    });
}

export async function check(pageId, selector, options = {}) {
    if (!selector) throw badRequest('selector is required');

    return withPage(pageId, async (page) => {
        await page
            .locator(selector)
            .first()
            .check({
                timeout: toTimeout(options.timeout),
                position: options.position,
                force: options.force,
            });

        return { checked: selector };
    });
}

export async function uncheck(pageId, selector, options = {}) {
    if (!selector) throw badRequest('selector is required');

    return withPage(pageId, async (page) => {
        await page
            .locator(selector)
            .first()
            .uncheck({
                timeout: toTimeout(options.timeout),
                position: options.position,
                force: options.force,
            });

        return { unchecked: selector };
    });
}

export async function fill(pageId, selector, value, options = {}) {
    if (!selector) throw badRequest('selector is required');

    return withPage(pageId, async (page) => {
        await page
            .locator(selector)
            .first()
            .fill(value ?? '', { timeout: toTimeout(options.timeout) });

        return { filled: selector };
    });
}

export async function type(pageId, selector, text, options = {}) {
    if (!selector) throw badRequest('selector is required');

    return withPage(pageId, async (page) => {
        await page
            .locator(selector)
            .first()
            .pressSequentially(text ?? '', {
                delay: options.delay ?? 10,
                timeout: toTimeout(options.timeout),
            });

        return { typed: selector };
    });
}

export async function press(pageId, selector, key, options = {}) {
    if (!key) throw badRequest('key is required');

    return withPage(pageId, async (page) => {
        if (selector) {
            await page
                .locator(selector)
                .first()
                .press(key, { timeout: toTimeout(options.timeout) });
        } else {
            await page.keyboard.press(key);
        }

        return { pressed: key };
    });
}

export async function keyboardType(pageId, text, options = {}) {
    return withPage(pageId, async (page) => {
        if (typeof page.keyboard.pressSequentially === 'function') {
            await page.keyboard.pressSequentially(text ?? '', {
                delay: options.delay ?? 10,
            });
        } else {
            await page.keyboard.type(text ?? '', {
                delay: options.delay ?? 10,
            });
        }

        return { typed: text };
    });
}

export async function keyboardPress(pageId, key) {
    if (!key) throw badRequest('key is required');

    return withPage(pageId, async (page) => {
        await page.keyboard.press(key);
        return { pressed: key };
    });
}

export async function mouseClick(pageId, x, y, options = {}) {
    return withPage(pageId, async (page) => {
        await page.mouse.click(Number(x), Number(y), {
            button: options.button,
            clickCount: options.clickCount,
        });

        return { clickedAt: { x: Number(x), y: Number(y) } };
    });
}

export async function mouseMove(pageId, x, y, options = {}) {
    return withPage(pageId, async (page) => {
        await page.mouse.move(Number(x), Number(y), {
            steps: options.steps,
        });

        return { movedTo: { x: Number(x), y: Number(y) } };
    });
}

export async function mouseWheel(pageId, deltaX = 0, deltaY = 0) {
    return withPage(pageId, async (page) => {
        await page.mouse.wheel(Number(deltaX), Number(deltaY));
        return { scrolled: { deltaX: Number(deltaX), deltaY: Number(deltaY) } };
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

export async function setInputFiles(pageId, selector, files, options = {}) {
    if (!selector) throw badRequest('selector is required');

    return withPage(pageId, async (page) => {
        await page
            .locator(selector)
            .first()
            .setInputFiles(normalizeFiles(files), {
                timeout: toTimeout(options.timeout),
            });

        return { ok: true };
    });
}

export async function dragAndDrop(pageId, source, target, options = {}) {
    if (!source) throw badRequest('source is required');
    if (!target) throw badRequest('target is required');

    return withPage(pageId, async (page) => {
        await page.dragAndDrop(source, target, {
            timeout: toTimeout(options.timeout),
            force: options.force,
        });

        return { dragged: { source, target } };
    });
}

export async function fillByLabel(pageId, label, value, options = {}) {
    if (!label) throw badRequest('label is required');

    return withPage(pageId, async (page) => {
        await page
            .getByLabel(label, { exact: options.exact ?? false })
            .first()
            .fill(value ?? '', { timeout: toTimeout(options.timeout) });

        return { filledByLabel: label };
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

/* ------------------------------- screenshots ---------------------------- */

export async function screenshot(pageId, options = {}) {
    return withPage(pageId, async (page) => {
        const opts = {
            fullPage: options.fullPage ?? true,
            type: options.type ?? 'png',
            omitBackground: options.omitBackground ?? false,
            timeout: toTimeout(options.timeout),
        };

        if (options.quality !== undefined) opts.quality = Number(options.quality);
        if (options.clip) opts.clip = options.clip;
        if (options.path) opts.path = options.path;

        const buffer = await page.screenshot(opts);

        if (options.path) {
            return {
                path: options.path,
                bytes: buffer.length,
            };
        }

        return {
            mimeType:
                opts.type === 'jpeg' || opts.type === 'jpg'
                    ? 'image/jpeg'
                    : 'image/png',
            encoding: 'base64',
            data: buffer.toString('base64'),
            bytes: buffer.length,
        };
    });
}

export async function pdf(pageId, options = {}) {
    return withPage(pageId, async (page) => {
        const opts = {};

        for (const key of [
            'path',
            'scale',
            'displayHeaderFooter',
            'headerTemplate',
            'footerTemplate',
            'printBackground',
            'landscape',
            'pageRanges',
            'format',
            'margin',
        ]) {
            if (options[key] !== undefined) opts[key] = options[key];
        }

        const buffer = await page.pdf(opts);

        if (options.path) {
            return {
                path: options.path,
                bytes: buffer.length,
            };
        }

        return {
            mimeType: 'application/pdf',
            encoding: 'base64',
            data: buffer.toString('base64'),
            bytes: buffer.length,
        };
    });
}

/* ------------------------------ frames ---------------------------------- */

export async function getFrames(pageId) {
    return withPage(pageId, async (page) => {
        return page.frames().map((frame, index) => ({
            index,
            url: frame.url(),
            name: frame.name(),
            isMain: frame === page.mainFrame(),
            parent: frame.parentFrame()?.url() ?? null,
        }));
    });
}

/* ------------------------------ cookies --------------------------------- */

export async function getCookies(pageId, urls) {
    return withPage(pageId, async (page, entry) => {
        const context = contextForPage(entry);

        const list = Array.isArray(urls)
            ? urls
            : urls
                ? [urls]
                : [page.url()];

        return context.cookies(list);
    });
}

export async function setCookies(pageId, cookies = []) {
    return withPage(pageId, async (_page, entry) => {
        const context = contextForPage(entry);
        await context.addCookies(Array.isArray(cookies) ? cookies : [cookies]);
        return { ok: true };
    });
}

export async function clearCookies(pageId) {
    return withPage(pageId, async (_page, entry) => {
        const context = contextForPage(entry);
        await context.clearCookies();
        return { ok: true };
    });
}

/* ------------------------------- storage -------------------------------- */

export async function storageOperation(
    pageId,
    type = 'local',
    operation = 'get',
    key = null,
    value = null
) {
    const storage = type === 'session' ? 'sessionStorage' : 'localStorage';

    return withPage(pageId, async (page) => {
        return page.evaluate(
            ({ storage, operation, key, value }) => {
                const s = window[storage];

                if (operation === 'get') {
                    if (key) return s.getItem(key);

                    const out = {};
                    for (let i = 0; i < s.length; i++) {
                        const k = s.key(i);
                        out[k] = s.getItem(k);
                    }

                    return out;
                }

                if (operation === 'set') {
                    if (!key) throw new Error('key is required');
                    s.setItem(key, value == null ? '' : String(value));
                    return true;
                }

                if (operation === 'remove') {
                    if (!key) throw new Error('key is required');
                    s.removeItem(key);
                    return true;
                }

                if (operation === 'clear') {
                    s.clear();
                    return true;
                }

                throw new Error('operation must be get, set, remove, or clear');
            },
            { storage, operation, key, value }
        );
    });
}

/* -------------------------------- headers ------------------------------- */

export async function setExtraHTTPHeaders(pageId, headers = {}) {
    return withPage(pageId, async (page) => {
        await page.setExtraHTTPHeaders(headers);
        return { ok: true };
    });
}

/* ------------------------------ network rules --------------------------- */

export async function addRouteRule(pageId, rule = {}) {
    if (!rule.urlPattern) throw badRequest('rule.urlPattern is required');

    if (!['abort', 'fulfill', 'continue'].includes(rule.action)) {
        throw badRequest('rule.action must be abort, fulfill, or continue');
    }

    return withPage(pageId, async (_page, entry) => {
        await ensureRouting(entry);
        entry.routeRules.push(rule);

        return {
            count: entry.routeRules.length,
            rules: entry.routeRules,
        };
    });
}

export async function clearRouteRules(pageId) {
    return withPage(pageId, async (_page, entry) => {
        entry.routeRules = [];
        return { ok: true };
    });
}

export async function blockResources(
    pageId,
    resourceTypes = ['image', 'stylesheet', 'font', 'media']
) {
    return withPage(pageId, async (_page, entry) => {
        await ensureRouting(entry);

        entry.blockResourceTypes = Array.isArray(resourceTypes)
            ? resourceTypes
            : [resourceTypes];

        return { blocked: entry.blockResourceTypes };
    });
}

export async function unblockResources(pageId) {
    return withPage(pageId, async (_page, entry) => {
        entry.blockResourceTypes = [];
        return { blocked: [] };
    });
}

/* -------------------------------- logs ---------------------------------- */

export function getConsole(pageId, limit = 100) {
    const entry = getPageEntry(pageId);
    return entry.console.slice(-clampLimit(limit));
}

export function getRequests(pageId, limit = 100) {
    const entry = getPageEntry(pageId);
    return entry.requests.slice(-clampLimit(limit));
}

export function getResponses(pageId, limit = 100) {
    const entry = getPageEntry(pageId);
    return entry.responses.slice(-clampLimit(limit));
}

export function getDownloads(pageId, limit = 100) {
    const entry = getPageEntry(pageId);
    return entry.downloads.slice(-clampLimit(limit));
}

export function getDialogs(pageId, limit = 100) {
    const entry = getPageEntry(pageId);
    return entry.dialogs.slice(-clampLimit(limit));
}

export function clearLogs(pageId) {
    const entry = getPageEntry(pageId);

    entry.console.length = 0;
    entry.requests.length = 0;
    entry.responses.length = 0;
    entry.downloads.length = 0;
    entry.dialogs.length = 0;

    return { ok: true };
}

/* ------------------------------- dialogs -------------------------------- */

export async function setDialogHandler(pageId, options = {}) {
    const action = options.action ?? 'dismiss';

    if (!['accept', 'dismiss'].includes(action)) {
        throw badRequest('action must be accept or dismiss');
    }

    return withPage(pageId, async (_page, entry) => {
        entry.dialogHandler = {
            action,
            promptText: options.promptText ?? '',
        };

        return { dialogHandler: entry.dialogHandler };
    });
}

/* ------------------------------- downloads ------------------------------ */

export async function setDownloadOptions(pageId, options = {}) {
    return withPage(pageId, async (_page, entry) => {
        entry.autoSaveDownloads = Boolean(options.autoSave);

        if (options.dir) {
            entry.downloadDir = options.dir;
        }

        return {
            autoSaveDownloads: entry.autoSaveDownloads,
            downloadDir: entry.downloadDir,
        };
    });
}

/* -------------------------------- routes -------------------------------- */

export default function setupBrowserRoutes(app) {
    /*
      Make sure your Express app has:
      app.use(express.json({ limit: '25mb' }));
    */

    /* ------------------------------ browsers ------------------------------ */

    app.post(
        '/api/browser',
        asyncRoute(async (req, res) => {
            const { id, options } = req.body || {};
            const { id: browserId } = await createBrowser(id, options);
            res.json({ id: browserId });
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

    /* ------------------------------ contexts ------------------------------ */

    app.post(
        '/api/browser/:id/context',
        asyncRoute(async (req, res) => {
            const { id } = await createContext(req.params.id, req.body || {});
            res.json({ id });
        })
    );

    app.delete(
        '/api/context/:contextId',
        asyncRoute(async (req, res) => {
            await closeContext(req.params.contextId);
            res.json({ message: 'Context closed' });
        })
    );

    /* -------------------------------- pages ------------------------------- */

    app.post(
        '/api/browser/:id/page',
        asyncRoute(async (req, res) => {
            const { id } = await newPage(req.params.id, req.body || {});
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

    app.post(
        '/api/page/:pageId/bring-to-front',
        asyncRoute(async (req, res) => {
            res.json(await bringToFront(req.params.pageId));
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
        '/api/page/:pageId/wait/function',
        asyncRoute(async (req, res) => {
            res.json(
                await waitForFunction(
                    req.params.pageId,
                    req.body?.script,
                    req.body?.arg,
                    req.body || {}
                )
            );
        })
    );

    app.post(
        '/api/page/:pageId/wait/timeout',
        asyncRoute(async (req, res) => {
            res.json(
                await waitForTimeout(
                    req.params.pageId,
                    req.body?.ms ?? req.body?.timeout ?? 1000
                )
            );
        })
    );

    app.post(
        '/api/page/:pageId/wait/request',
        asyncRoute(async (req, res) => {
            res.json(
                await waitForRequest(
                    req.params.pageId,
                    req.body?.urlPattern,
                    req.body || {}
                )
            );
        })
    );

    app.post(
        '/api/page/:pageId/wait/response',
        asyncRoute(async (req, res) => {
            res.json(
                await waitForResponse(
                    req.params.pageId,
                    req.body?.urlPattern,
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

    /* ------------------------------- content ------------------------------ */

    app.get(
        '/api/page/:pageId/title',
        asyncRoute(async (req, res) => {
            res.json(await getTitle(req.params.pageId));
        })
    );

    app.get(
        '/api/page/:pageId/url',
        asyncRoute(async (req, res) => {
            res.json(await getUrl(req.params.pageId));
        })
    );

    app.get(
        '/api/page/:pageId/content',
        asyncRoute(async (req, res) => {
            res.json({ html: await getContent(req.params.pageId) });
        })
    );

    app.post(
        '/api/page/:pageId/set-content',
        asyncRoute(async (req, res) => {
            res.json(
                await setContent(req.params.pageId, req.body?.html, req.body || {})
            );
        })
    );

    app.get(
        '/api/page/:pageId/text',
        asyncRoute(async (req, res) => {
            res.json({ text: await getBodyText(req.params.pageId) });
        })
    );

    app.post(
        '/api/page/:pageId/text',
        asyncRoute(async (req, res) => {
            res.json(
                await getText(req.params.pageId, req.body?.selector, req.body || {})
            );
        })
    );

    app.get(
        '/api/page/:pageId/markdown',
        asyncRoute(async (req, res) => {
            res.json({ markdown: await getMarkdown(req.params.pageId) });
        })
    );

    app.get(
        '/api/page/:pageId/snapshot',
        asyncRoute(async (req, res) => {
            res.json(await agentSnapshot(req.params.pageId, req.query || {}));
        })
    );

    app.get(
        '/api/page/:pageId/accessibility',
        asyncRoute(async (req, res) => {
            res.json({
                accessibility: await getAccessibilitySnapshot(
                    req.params.pageId,
                    req.query || {}
                ),
            });
        })
    );

    app.get(
        '/api/page/:pageId/frames',
        asyncRoute(async (req, res) => {
            res.json({ frames: await getFrames(req.params.pageId) });
        })
    );

    /* ---------------------------- screenshot / pdf ------------------------ */

    app.post(
        '/api/page/:pageId/screenshot',
        asyncRoute(async (req, res) => {
            res.json(await screenshot(req.params.pageId, req.body || {}));
        })
    );

    app.post(
        '/api/page/:pageId/pdf',
        asyncRoute(async (req, res) => {
            res.json(await pdf(req.params.pageId, req.body || {}));
        })
    );

    /* ------------------------------- actions ------------------------------ */

    app.post(
        '/api/page/:pageId/click',
        asyncRoute(async (req, res) => {
            res.json(
                await click(req.params.pageId, req.body?.selector, req.body || {})
            );
        })
    );

    app.post(
        '/api/page/:pageId/dblclick',
        asyncRoute(async (req, res) => {
            res.json(
                await dblclick(req.params.pageId, req.body?.selector, req.body || {})
            );
        })
    );

    app.post(
        '/api/page/:pageId/right-click',
        asyncRoute(async (req, res) => {
            res.json(
                await rightClick(req.params.pageId, req.body?.selector, req.body || {})
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
        '/api/page/:pageId/hover',
        asyncRoute(async (req, res) => {
            res.json(
                await hover(req.params.pageId, req.body?.selector, req.body || {})
            );
        })
    );

    app.post(
        '/api/page/:pageId/focus',
        asyncRoute(async (req, res) => {
            res.json(
                await focus(req.params.pageId, req.body?.selector, req.body || {})
            );
        })
    );

    app.post(
        '/api/page/:pageId/check',
        asyncRoute(async (req, res) => {
            res.json(
                await check(req.params.pageId, req.body?.selector, req.body || {})
            );
        })
    );

    app.post(
        '/api/page/:pageId/uncheck',
        asyncRoute(async (req, res) => {
            res.json(
                await uncheck(req.params.pageId, req.body?.selector, req.body || {})
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
        '/api/page/:pageId/type',
        asyncRoute(async (req, res) => {
            res.json(
                await type(
                    req.params.pageId,
                    req.body?.selector,
                    req.body?.text,
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
        '/api/page/:pageId/keyboard-type',
        asyncRoute(async (req, res) => {
            res.json(
                await keyboardType(req.params.pageId, req.body?.text, req.body || {})
            );
        })
    );

    app.post(
        '/api/page/:pageId/keyboard-press',
        asyncRoute(async (req, res) => {
            res.json(await keyboardPress(req.params.pageId, req.body?.key));
        })
    );

    app.post(
        '/api/page/:pageId/mouse-click',
        asyncRoute(async (req, res) => {
            res.json(
                await mouseClick(
                    req.params.pageId,
                    req.body?.x,
                    req.body?.y,
                    req.body || {}
                )
            );
        })
    );

    app.post(
        '/api/page/:pageId/mouse-move',
        asyncRoute(async (req, res) => {
            res.json(
                await mouseMove(
                    req.params.pageId,
                    req.body?.x,
                    req.body?.y,
                    req.body || {}
                )
            );
        })
    );

    app.post(
        '/api/page/:pageId/mouse-wheel',
        asyncRoute(async (req, res) => {
            res.json(
                await mouseWheel(
                    req.params.pageId,
                    req.body?.deltaX,
                    req.body?.deltaY
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
        '/api/page/:pageId/set-input-files',
        asyncRoute(async (req, res) => {
            res.json(
                await setInputFiles(
                    req.params.pageId,
                    req.body?.selector,
                    req.body?.files,
                    req.body || {}
                )
            );
        })
    );

    app.post(
        '/api/page/:pageId/drag',
        asyncRoute(async (req, res) => {
            res.json(
                await dragAndDrop(
                    req.params.pageId,
                    req.body?.source,
                    req.body?.target,
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

    /* -------------------------------- queries ----------------------------- */

    app.post(
        '/api/page/:pageId/element',
        asyncRoute(async (req, res) => {
            res.json(
                await getElement(req.params.pageId, req.body?.selector, req.body || {})
            );
        })
    );

    app.post(
        '/api/page/:pageId/elements',
        asyncRoute(async (req, res) => {
            res.json(
                await getElements(
                    req.params.pageId,
                    req.body?.selector,
                    req.body || {}
                )
            );
        })
    );

    app.post(
        '/api/page/:pageId/count',
        asyncRoute(async (req, res) => {
            res.json(await count(req.params.pageId, req.body?.selector));
        })
    );

    app.post(
        '/api/page/:pageId/attribute',
        asyncRoute(async (req, res) => {
            res.json(
                await getAttribute(
                    req.params.pageId,
                    req.body?.selector,
                    req.body?.attribute,
                    req.body || {}
                )
            );
        })
    );

    app.post(
        '/api/page/:pageId/value',
        asyncRoute(async (req, res) => {
            res.json(
                await getValue(req.params.pageId, req.body?.selector, req.body || {})
            );
        })
    );

    app.post(
        '/api/page/:pageId/inner-html',
        asyncRoute(async (req, res) => {
            res.json(
                await getInnerHTML(
                    req.params.pageId,
                    req.body?.selector,
                    req.body || {}
                )
            );
        })
    );

    app.post(
        '/api/page/:pageId/visible',
        asyncRoute(async (req, res) => {
            res.json(await isVisible(req.params.pageId, req.body?.selector));
        })
    );

    app.post(
        '/api/page/:pageId/enabled',
        asyncRoute(async (req, res) => {
            res.json(await isEnabled(req.params.pageId, req.body?.selector));
        })
    );

    app.post(
        '/api/page/:pageId/checked',
        asyncRoute(async (req, res) => {
            res.json(await isChecked(req.params.pageId, req.body?.selector));
        })
    );

    app.post(
        '/api/page/:pageId/bounding-box',
        asyncRoute(async (req, res) => {
            res.json(await getBoundingBox(req.params.pageId, req.body?.selector));
        })
    );

    app.post(
        '/api/page/:pageId/extract',
        asyncRoute(async (req, res) => {
            res.json({
                data: await extract(req.params.pageId, req.body?.spec || {}),
            });
        })
    );

    /* ------------------------------ evaluation ---------------------------- */

    app.post(
        '/api/page/:pageId/evaluate',
        asyncRoute(async (req, res) => {
            res.json({
                result: await evaluate(
                    req.params.pageId,
                    req.body?.script,
                    req.body?.arg,
                    req.body || {}
                ),
            });
        })
    );

    app.post(
        '/api/page/:pageId/evaluate-frame',
        asyncRoute(async (req, res) => {
            res.json({
                result: await evaluateInFrame(
                    req.params.pageId,
                    req.body?.script,
                    req.body?.arg,
                    req.body || {}
                ),
            });
        })
    );

    /* ------------------------------- cookies ------------------------------ */

    app.get(
        '/api/page/:pageId/cookies',
        asyncRoute(async (req, res) => {
            const urls = req.query.urls
                ? String(req.query.urls)
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean)
                : undefined;

            res.json({ cookies: await getCookies(req.params.pageId, urls) });
        })
    );

    app.post(
        '/api/page/:pageId/cookies',
        asyncRoute(async (req, res) => {
            res.json(await setCookies(req.params.pageId, req.body?.cookies));
        })
    );

    app.delete(
        '/api/page/:pageId/cookies',
        asyncRoute(async (req, res) => {
            res.json(await clearCookies(req.params.pageId));
        })
    );

    /* -------------------------------- storage ----------------------------- */

    app.get(
        '/api/page/:pageId/storage/:type',
        asyncRoute(async (req, res) => {
            const key = req.query.key ? String(req.query.key) : null;

            res.json({
                value: await storageOperation(
                    req.params.pageId,
                    req.params.type,
                    'get',
                    key
                ),
            });
        })
    );

    app.post(
        '/api/page/:pageId/storage',
        asyncRoute(async (req, res) => {
            res.json(
                await storageOperation(
                    req.params.pageId,
                    req.body?.type || 'local',
                    req.body?.operation || 'get',
                    req.body?.key ?? null,
                    req.body?.value ?? null
                )
            );
        })
    );

    /* -------------------------------- headers ----------------------------- */

    app.post(
        '/api/page/:pageId/headers',
        asyncRoute(async (req, res) => {
            res.json(
                await setExtraHTTPHeaders(req.params.pageId, req.body?.headers || {})
            );
        })
    );

    /* ------------------------------ network/logs -------------------------- */

    app.get(
        '/api/page/:pageId/console',
        asyncRoute(async (req, res) => {
            res.json({
                console: getConsole(req.params.pageId, req.query.limit),
            });
        })
    );

    app.get(
        '/api/page/:pageId/requests',
        asyncRoute(async (req, res) => {
            res.json({
                requests: getRequests(req.params.pageId, req.query.limit),
            });
        })
    );

    app.get(
        '/api/page/:pageId/responses',
        asyncRoute(async (req, res) => {
            res.json({
                responses: getResponses(req.params.pageId, req.query.limit),
            });
        })
    );

    app.get(
        '/api/page/:pageId/downloads',
        asyncRoute(async (req, res) => {
            res.json({
                downloads: getDownloads(req.params.pageId, req.query.limit),
            });
        })
    );

    app.get(
        '/api/page/:pageId/dialogs',
        asyncRoute(async (req, res) => {
            res.json({
                dialogs: getDialogs(req.params.pageId, req.query.limit),
            });
        })
    );

    app.delete(
        '/api/page/:pageId/logs',
        asyncRoute(async (req, res) => {
            res.json(clearLogs(req.params.pageId));
        })
    );

    app.post(
        '/api/page/:pageId/route/rule',
        asyncRoute(async (req, res) => {
            const rule = req.body?.rule ?? req.body;
            res.json(await addRouteRule(req.params.pageId, rule));
        })
    );

    app.delete(
        '/api/page/:pageId/route/rules',
        asyncRoute(async (req, res) => {
            res.json(await clearRouteRules(req.params.pageId));
        })
    );

    app.post(
        '/api/page/:pageId/block-resources',
        asyncRoute(async (req, res) => {
            res.json(
                await blockResources(req.params.pageId, req.body?.resourceTypes)
            );
        })
    );

    app.post(
        '/api/page/:pageId/unblock-resources',
        asyncRoute(async (req, res) => {
            res.json(await unblockResources(req.params.pageId));
        })
    );

    /* -------------------------------- dialogs ----------------------------- */

    app.post(
        '/api/page/:pageId/dialog',
        asyncRoute(async (req, res) => {
            res.json(await setDialogHandler(req.params.pageId, req.body || {}));
        })
    );

    /* ------------------------------- downloads ---------------------------- */

    app.post(
        '/api/page/:pageId/download-options',
        asyncRoute(async (req, res) => {
            res.json(await setDownloadOptions(req.params.pageId, req.body || {}));
        })
    );
}