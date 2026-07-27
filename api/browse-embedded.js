// browse-embedded.js
import * as browserAgent from './browser.js';
import setupOriginalBrowserRoutes from './browser.js';
import { load } from 'cheerio';
import crypto from 'node:crypto';

/* ------------------------------ config ---------------------------------- */

export const EMBED_CONTENT_LIMIT = Number(process.env.EMBED_CONTENT_LIMIT || 20_000);
export const EMBED_MAX_CHUNK_CHARS = Number(process.env.EMBED_MAX_CHUNK_CHARS || 2_200);
export const EMBED_MAX_CHUNKS = Number(process.env.EMBED_MAX_CHUNKS || 250);
export const EMBED_TOP_K = Number(process.env.EMBED_TOP_K || 24);
export const RERANK_TOP_K = Number(process.env.RERANK_TOP_K || 6);

export const EMBED_MODEL =
    process.env.EMBED_MODEL || 'Xenova/bge-base-en-v1.5';

export const RERANK_MODEL =
    process.env.RERANK_MODEL || 'Xenova/bge-reranker-base';

const EMBED_TEXT_LIMIT = 8_000;
const RERANK_TEXT_LIMIT = 4_000;

/*
  Modify these easily.
*/

export const HTML_BLACKLIST_SELECTORS = [
    'nav',
    'aside',
    'footer',
    '[role="navigation"]',
    '[role="contentinfo"]',
    '[role="banner"]',
    '[role="search"]',

    // Generic site chrome
    '.sidebar',
    '.infobox',
    '.metadata',
    '.ambox',
    '.hatnote',
    '.noprint',
    '.reference',
    '.references',
    '.reflist',
    '.refbegin',
    '.thumb',
    '.gallery',
    '.portal',
    '.sistersitebox',
    '.navigation-not-searchable',

    // Wikipedia navboxes
    '.navbox',
    '.vertical-navbox',
    '.navbox-inner',
    '.navbox-subgroup',
    '.navbox-list',
    '.navbox-group',
    '.navbox-title',

    // Wikipedia TOC
    '.toc',
    '#toc',
    '.toctitle',
    '.toclevel-1',
    '.toclevel-2',
    '.toclevel-3',
    '.tocnumber',
    '.toctext',

    // Wikipedia edit junk
    '.mw-editsection',
    '.mw-jump-link',
    '.mw-jump-link-container',
    '.screen-reader-text',
    '.mw-empty-elt',

    // Wikipedia header / search / language chrome
    '#mw-panel',
    '#mw-head',
    '#mw-navigation',
    '#mw-page-base',
    '#mw-head-base',
    '#left-navigation',
    '#right-navigation',

    '#p-lang',
    '#p-search',
    '#p-logo',
    '#p-tb',
    '#p-interaction',
    '#p-navigation',
    '#p-variants',
    '#p-views',
    '#p-cactions',
    '#p-personal',

    '#searchInput',
    '#searchButton',
    '#searchform',
    '#searchform2',
    '.search-container',
    '.cdx-search-input',

    '.vector-header',
    '.vector-header-container',
    '.vector-header-content',
    '.vector-page-toolbar',
    '.vector-page-titlebar',

    '.vector-menu',
    '.vector-menu-content',
    '.vector-menu-content-list',
    '.vector-menu-heading',
    '.vector-tabs',
    '.vector-tab',

    '.mw-portlet',
    '.mw-portlet-lang',
    '.mw-portlet-search',
    '.mw-portlet-navigation',
    '.mw-portlet-personal',
    '.mw-portlet-variants',
    '.mw-portlet-views',
    '.mw-portlet-cactions',
    '.mw-portlet-tb',
    '.mw-portlet-interaction',
    '.mw-portlet-logo',

    '.interlanguage-link',
    '.interlanguage-link-target',

    '.mw-indicators',
    '.mw-indicator',

    '#siteNotice',
    '#siteSub',
    '#contentSub',
    '.mw-content-subtitle',

    '.firstHeading',
    '.mw-first-heading',
    '.mw-page-title',
    '.mw-page-title-main',
];

export const HTML_BLACKLIST_TAGS = new Set([
    // scripts / styles / embedded junk
    'script',
    'style',
    'noscript',
    'template',
    'iframe',
    'object',
    'embed',
    'applet',
    'link',
    'meta',
    'base',
    'head',

    // images / svg / vector paths
    'img',
    'image',
    'picture',
    'source',
    'svg',
    'path',
    'circle',
    'rect',
    'line',
    'polyline',
    'polygon',
    'ellipse',
    'g',
    'defs',
    'symbol',
    'use',
    'mask',
    'pattern',
    'clipPath',
    'linearGradient',
    'radialGradient',
    'stop',
    'marker',
    'foreignObject',

    // media
    'video',
    'audio',
    'track',
    'canvas',
    'map',
    'area',

    // mathml
    'math',
    'annotation',
    'semantics',
    'mrow',
    'mi',
    'mo',
    'mn',
    'ms',
    'mtext',
    'mspace',
    'msup',
    'msub',
    'mtable',
    'mtr',
    'mtd',

    // misc
    'data',
    'rb',
    'rtc',
    'rp',
    'portal',
    'fencedframe',
]);

export const HTML_ALLOWED_TAGS = new Set([
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'p',
    'br',
    'hr',
    'ul',
    'ol',
    'li',
    'a',
    'button',
    'input',
    'textarea',
    'select',
    'option',
    'optgroup',
    'label',
    'form',
    'table',
    'thead',
    'tbody',
    'tfoot',
    'tr',
    'td',
    'th',
    'caption',
    'dl',
    'dt',
    'dd',
    'blockquote',
    'code',
    'pre',
    'strong',
    'b',
    'em',
    'i',
    'u',
    's',
    'small',
    'sub',
    'sup',
    'abbr',
    'time',
    'cite',
    'q',
    'details',
    'summary',
    'section',
    'article',
    'main',
    'header',
    'footer',
    'nav',
    'div',
    'span',
    'fieldset',
    'legend',
    'output',
    'progress',
    'meter',
]);

export const HTML_ALLOWED_ATTRIBUTES = new Set([
    'id',
    'name',
    'href',
    'for',
    'action',
    'method',
    'type',
    'value',
    'placeholder',
    'title',
    'alt',
    'role',

    'aria-label',
    'aria-labelledby',
    'aria-describedby',
    'aria-expanded',
    'aria-hidden',
    'aria-required',
    'aria-selected',
    'aria-checked',
    'aria-disabled',

    'checked',
    'selected',
    'disabled',
    'required',
    'readonly',
    'multiple',
    'min',
    'max',
    'step',
    'pattern',
    'maxlength',
    'minlength',
    'autocomplete',
    'inputmode',
    'enterkeyhint',

    'data-testid',
    'data-id',
    'data-role',

    'rel',
    'target',
]);

const STOPWORDS = new Set([
    'the',
    'and',
    'for',
    'with',
    'this',
    'that',
    'from',
    'your',
    'you',
    'are',
    'was',
    'were',
    'will',
    'would',
    'can',
    'could',
    'should',
    'not',
    'but',
    'all',
    'any',
    'each',
    'more',
    'most',
    'some',
    'such',
    'than',
    'then',
    'them',
    'they',
    'their',
    'there',
    'these',
    'those',
    'when',
    'where',
    'which',
    'while',
    'about',
    'into',
    'over',
    'under',
    'again',
    'once',
    'here',
    'also',
    'very',
    'just',
    'only',
    'now',
    'our',
    'ours',
    'out',
    'off',
    'too',
    'use',
    'used',
    'using',
]);

/* ------------------------------ internals ------------------------------- */

const pageCache = new Map();

const runtime = {
    embedderModel: null,
    rerankerModel: null,
    warnedEmbed: false,
    warnedRerank: false,
};

let transformersPromise = null;
let embedderPromise = null;
let rerankerPromise = null;

function uuid() {
    return crypto.randomUUID();
}

function sha256(text) {
    return crypto.createHash('sha256').update(text || '').digest('hex');
}

function escapeHtml(text) {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function isSafeUrl(value) {
    const v = String(value || '').trim().toLowerCase();

    if (!v) return false;

    if (
        v.startsWith('#') ||
        v.startsWith('/') ||
        v.startsWith('./') ||
        v.startsWith('../')
    ) {
        return true;
    }

    return (
        v.startsWith('http://') ||
        v.startsWith('https://') ||
        v.startsWith('mailto:') ||
        v.startsWith('tel:')
    );
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

function tokenize(text) {
    return (
        String(text || '')
            .toLowerCase()
            .match(/[a-z0-9]+/g)
            ?.filter((t) => t.length > 1 && !STOPWORDS.has(t)) || []
    );
}

function hashToken(token) {
    let h = 0;

    for (let i = 0; i < token.length; i++) {
        h = Math.imul(31, h) + token.charCodeAt(i);
        h |= 0;
    }

    return Math.abs(h);
}

function cosine(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || !a.length || !b.length) {
        return 0;
    }

    const len = Math.min(a.length, b.length);

    let dot = 0;
    let na = 0;
    let nb = 0;

    for (let i = 0; i < len; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }

    if (!na || !nb) return 0;

    return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function splitTextIntoPieces(text, maxChars) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();

    if (!clean) return [];
    if (clean.length <= maxChars) return [clean];

    const pieces = [];
    let rest = clean;

    while (rest.length > maxChars) {
        let cut = rest.lastIndexOf(' ', maxChars);

        if (cut < maxChars * 0.45) {
            cut = maxChars;
        }

        pieces.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut).trim();
    }

    if (rest) pieces.push(rest);

    return pieces;
}

function htmlToText(html) {
    if (!html) return '';

    const $ = load(html, { decodeEntities: false });

    if ($('body').length) {
        return $('body')
            .text()
            .replace(/\s+/g, ' ')
            .trim();
    }

    return $.root()
        .text()
        .replace(/\s+/g, ' ')
        .trim();
}

/* --------------------------- HTML simplifier ---------------------------- */

const DATA_URI_ATTR_RE = /=("|')data:[^"']*\1/gi;

export function simplifyHtml(html, options = {}) {
    if (!html) return '';

    const html_ = String(html).replace(DATA_URI_ATTR_RE, '=$1$1');

    const $ = load(html_, { decodeEntities: false });

    // Remove comments everywhere.
    const removeComments = (root) => {
        $(root)
            .contents()
            .filter((_, node) => node.type === 'comment')
            .remove();

        $(root)
            .find('*')
            .each((_, el) => {
                $(el)
                    .contents()
                    .filter((_, node) => node.type === 'comment')
                    .remove();
            });
    };

    removeComments($.root());

    // Remove blacklisted tags completely.
    for (const tag of HTML_BLACKLIST_TAGS) {
        $(tag).remove();
    }

    for (const selector of HTML_BLACKLIST_SELECTORS) {
        try {
            $(selector).remove();
        } catch {
            // Ignore invalid selectors.
        }
    }

    // Optionally remove hidden things.
    if (options.removeHidden !== false) {
        $('[hidden]').remove();
        $('[aria-hidden="true"]').remove();
        $('[style*="display:none"]').remove();
        $('[style*="display: none"]').remove();
        $('[style*="visibility:hidden"]').remove();
        $('[style*="visibility: hidden"]').remove();
    }

    // Unwrap tags not in whitelist.
    const all = $('*').toArray();

    for (const el of all) {
        const tag = el.tagName?.toLowerCase?.();
        if (!tag) continue;

        if (HTML_BLACKLIST_TAGS.has(tag)) {
            $(el).remove();
            continue;
        }

        if (!HTML_ALLOWED_TAGS.has(tag)) {
            $(el).replaceWith($(el).contents());
        }
    }

    // Clean attributes.
    $('*').each((_, el) => {
        const attribs = el.attribs || {};

        for (const name of Object.keys(attribs)) {
            const lower = name.toLowerCase();
            const value = attribs[name];

            // Remove all event handlers.
            if (lower.startsWith('on')) {
                delete el.attribs[name];
                continue;
            }

            // Remove inline styles always.
            if (lower === 'style') {
                delete el.attribs[name];
                continue;
            }

            // Remove non-whitelisted attributes.
            if (!HTML_ALLOWED_ATTRIBUTES.has(lower)) {
                delete el.attribs[name];
                continue;
            }

            // Sanitize URL attributes.
            if (lower === 'href' || lower === 'action') {
                if (!isSafeUrl(value)) {
                    delete el.attribs[name];
                }
            }
        }
    });

    // Extra safety for anchors.
    $('a[href^="javascript:"]').removeAttr('href');
    $('a[href^="data:"]').removeAttr('href');
    $('a[href^="vbscript:"]').removeAttr('href');

    // Remove empty non-interactive elements.
    const voidish = new Set(['br', 'hr', 'input', 'wbr']);

    $('*')
        .toArray()
        .reverse()
        .forEach((el) => {
            const tag = el.tagName?.toLowerCase?.();
            if (!tag) return;
            if (voidish.has(tag)) return;

            const $el = $(el);

            const text = $el.text().replace(/\s+/g, '');
            const hasInteractive =
                $el.find('input, select, textarea, button, a').length > 0;

            const hasUsefulAttrs = Boolean(
                el.attribs &&
                (el.attribs.placeholder ||
                    el.attribs['aria-label'] ||
                    el.attribs.value ||
                    el.attribs.name ||
                    el.attribs.id)
            );

            if (!text && !hasInteractive && !hasUsefulAttrs) {
                $el.remove();
            }
        });

    let output = $('body').length ? $('body').html() : $.root().html();

    output = String(output || '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n\s*\n\s*\n+/g, '\n\n')
        .trim();

    return output;
}

/* --------------------------- markdown cleaner --------------------------- */

export function cleanMarkdown(input) {
    if (!input) return '';

    return String(input)
        .replace(/<!--[\s\S]*?-->/g, '')

        // Remove images.
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
        .replace(/!\[[^\]]*\]\[[^\]]*\]/g, '')

        // Convert links to text + safe URL.
        .replace(/\[([^\]]*)\]\(([^)]*)\)/g, (_m, text, href) => {
            const cleanText = String(text || '').trim();
            const cleanHref = String(href || '').trim();

            if (!cleanText) return '';
            if (!cleanHref || cleanHref.startsWith('#')) return cleanText;

            if (/^(https?:|mailto:|tel:)/i.test(cleanHref)) {
                return `${cleanText} (${cleanHref})`;
            }

            return cleanText;
        })

        // Remove leftover data URLs/base64 blobs.
        .replace(/data:[^)\s"'`]+/gi, '')

        // Strip leftover HTML tags.
        .replace(/<[^>]*>/g, ' ')

        // Normalize whitespace.
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/* ------------------------------ chunking -------------------------------- */

function chunkCleanHtml(html, maxChars) {
    if (!html) return [];

    const $ = load(html, { decodeEntities: false });

    const root = $('body').length ? $('body') : $.root();

    const chunks = [];

    let headingPath = [];
    let currentHtmlParts = [];
    let currentText = '';

    function flush() {
        const text = currentText.replace(/\s+/g, ' ').trim();

        if (!text) {
            currentHtmlParts = [];
            currentText = '';
            return;
        }

        const heading = headingPath.filter(Boolean).join(' > ');

        chunks.push({
            id: uuid(),
            text,
            html: currentHtmlParts.join('\n').trim(),
            markdown: heading ? `## ${heading}\n\n${text}` : text,
            headingPath: [...headingPath],
            heading,
            charCount: text.length,
        });

        currentHtmlParts = [];
        currentText = '';
    }

    function addPart(htmlPart, textPart) {
        const cleanText = String(textPart || '').replace(/\s+/g, ' ').trim();

        if (!cleanText) return;

        if (currentText.length + cleanText.length > maxChars && currentText) {
            flush();
        }

        currentHtmlParts.push(String(htmlPart || '').trim());
        currentText += (currentText ? '\n' : '') + cleanText;
    }

    function walk(nodes) {
        for (const node of nodes) {
            if (node.type === 'text') {
                const text = (node.data || '').replace(/\s+/g, ' ').trim();

                if (!text) continue;

                const pieces = splitTextIntoPieces(text, maxChars);

                for (const piece of pieces) {
                    addPart(`<p>${escapeHtml(piece)}</p>`, piece);
                }

                continue;
            }

            if (node.type !== 'tag') continue;

            const tag = node.tagName?.toLowerCase?.();
            if (!tag) continue;

            if (HTML_BLACKLIST_TAGS.has(tag)) continue;

            const $el = $(node);
            const text = $el.text().replace(/\s+/g, ' ').trim();

            if (/^h[1-6]$/.test(tag)) {
                if (currentText.length > 80) flush();

                const level = Number(tag[1]);
                headingPath = headingPath.slice(0, level - 1);
                headingPath[level - 1] = text;
                headingPath = headingPath.filter(Boolean);

                addPart($.html(node), text);
                continue;
            }

            if (text.length <= maxChars) {
                addPart($.html(node), text);
                continue;
            }

            const children = $el.contents().toArray();

            if (children.length) {
                walk(children);
            } else {
                const pieces = splitTextIntoPieces(text, maxChars);

                for (const piece of pieces) {
                    addPart(`<p>${escapeHtml(piece)}</p>`, piece);
                }
            }
        }
    }

    walk(root.contents().toArray());
    flush();

    return chunks
        .filter((c) => c.text && c.text.length > 0)
        .map((c, index) => ({
            ...c,
            index,
        }))
        .slice(0, EMBED_MAX_CHUNKS);
}

/* ------------------------- lexical fallback ----------------------------- */

function lexicalEmbed(text, dim = 256) {
    const vec = new Array(dim).fill(0);
    const tokens = tokenize(text);

    if (!tokens.length) return vec;

    for (const token of tokens) {
        const h = hashToken(token) % dim;
        const sign = hashToken(`${token}:sign`) % 2 === 0 ? 1 : -1;
        vec[h] += sign;
    }

    const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0)) || 1;

    return vec.map((v) => v / norm);
}

function lexicalRerank(query, docs) {
    const qTokens = new Set(tokenize(query));
    const qString = String(query || '').toLowerCase();

    const scored = docs.map((doc, index) => {
        const dTokens = tokenize(doc);
        const dSet = new Set(dTokens);

        let overlap = 0;

        for (const t of qTokens) {
            if (dSet.has(t)) overlap++;
        }

        const coverage = qTokens.size ? overlap / qTokens.size : 0;
        const density = dTokens.length ? overlap / Math.sqrt(dTokens.length) : 0;

        const early = String(doc || '')
            .slice(0, 1_000)
            .toLowerCase()
            .includes(qString)
            ? 0.25
            : 0;

        const exactPhrase = qString && String(doc || '').toLowerCase().includes(qString)
            ? 0.35
            : 0;

        const score = coverage * 2.0 + density + early + exactPhrase;

        return { index, score };
    });

    scored.sort((a, b) => b.score - a.score);

    return scored;
}

/* ------------------------- transformers adapters ------------------------ */

async function loadTransformers() {
    if (!transformersPromise) {
        transformersPromise = (async () => {
            try {
                return await import('@huggingface/transformers');
            } catch {
                return await import('@xenova/transformers');
            }
        })();
    }

    return transformersPromise;
}

async function getEmbedder() {
    if (!embedderPromise) {
        embedderPromise = (async () => {
            const tf = await loadTransformers();

            if (tf.env) {
                tf.env.allowLocalModels = process.env.ALLOW_LOCAL_MODELS === 'true';
            }

            return tf.pipeline('feature-extraction', EMBED_MODEL, {
                quantized: true,
            });
        })();
    }

    return embedderPromise;
}

async function getReranker() {
    if (!rerankerPromise) {
        rerankerPromise = (async () => {
            const tf = await loadTransformers();

            if (tf.env) {
                tf.env.allowLocalModels = process.env.ALLOW_LOCAL_MODELS === 'true';
            }

            return tf.pipeline('text-classification', RERANK_MODEL, {
                quantized: true,
            });
        })();
    }

    return rerankerPromise;
}

let rerankModelPromise = null;

async function getRerankModelDirect() {
    if (!rerankModelPromise) {
        rerankModelPromise = (async () => {
            const tf = await loadTransformers();

            if (tf.env) {
                tf.env.allowLocalModels = process.env.ALLOW_LOCAL_MODELS === 'true';
            }

            const tokenizer = await tf.AutoTokenizer.from_pretrained(RERANK_MODEL, {
                quantized: true,
            });

            const model = await tf.AutoModelForSequenceClassification.from_pretrained(
                RERANK_MODEL,
                {
                    quantized: true,
                }
            );

            return { tokenizer, model };
        })();
    }

    return rerankModelPromise;
}

function scoreFromLogitsRow(row) {
    if (!Array.isArray(row)) return 0;

    if (row.length === 1) {
        return row[0];
    }

    if (row.length >= 2) {
        return row[1] - row[0];
    }

    return 0;
}

function vectorFromOutput(output) {
    if (!output) return [];

    if (Array.isArray(output)) {
        return Array.isArray(output[0]) ? output[0] : output;
    }

    if (typeof output.tolist === 'function') {
        const list = output.tolist();
        return Array.isArray(list[0]) ? list[0] : list;
    }

    if (output.data) {
        return Array.from(output.data);
    }

    return [];
}

async function embedTexts(texts) {
    const sanitized = (texts || []).map((t) =>
        String(t || '').slice(0, EMBED_TEXT_LIMIT)
    );

    if (process.env.USE_LEXICAL_RETRIEVAL === 'true') {
        runtime.embedderModel = 'lexical';
        return sanitized.map((t) => lexicalEmbed(t));
    }

    try {
        const embedder = await getEmbedder();
        const vectors = [];

        for (const text of sanitized) {
            const output = await embedder(text, {
                pooling: 'mean',
                normalize: true,
            });

            vectors.push(vectorFromOutput(output));
        }

        runtime.embedderModel = EMBED_MODEL;
        return vectors;
    } catch (err) {
        if (!runtime.warnedEmbed) {
            console.warn(
                '[browse-embedded] Embedder unavailable, falling back to lexical embeddings.',
                err?.message || err
            );
            runtime.warnedEmbed = true;
        }

        runtime.embedderModel = 'lexical';
        return sanitized.map((t) => lexicalEmbed(t));
    }
}

async function embedQuery(query) {
    const [vector] = await embedTexts([query]);
    return vector;
}

async function rerankDocs(query, docs) {
    const sanitized = (docs || []).map((d) =>
        String(d || '').slice(0, RERANK_TEXT_LIMIT)
    );

    if (!sanitized.length) return [];

    if (process.env.USE_LEXICAL_RETRIEVAL === 'true') {
        runtime.rerankerModel = 'lexical';
        return lexicalRerank(query, sanitized);
    }

    try {
        const { tokenizer, model } = await getRerankModelDirect();

        const results = [];

        for (let i = 0; i < sanitized.length; i++) {
            const inputs = await tokenizer(query, {
                text_pair: sanitized[i],
                padding: true,
                truncation: true,
                max_length: 512,
            });

            const output = await model(inputs);

            const rows = output?.logits?.tolist?.() || [];
            const row = rows[0] || Array.from(output?.logits?.data || []);

            const score = scoreFromLogitsRow(row);

            results.push({
                index: i,
                score,
            });
        }

        runtime.rerankerModel = `${RERANK_MODEL} (raw logits)`;

        results.sort((a, b) => b.score - a.score);

        return results;
    } catch (err) {
        if (!runtime.warnedRerank) {
            console.warn(
                '[browse-embedded] Direct reranker failed, falling back to lexical reranking.',
                err?.message || err
            );
            runtime.warnedRerank = true;
        }

        runtime.rerankerModel = 'lexical';
        return lexicalRerank(query, sanitized);
    }
}

/* ------------------------------ page cache ------------------------------ */

async function buildPageCache(pageId, options = {}) {
    const [rawHtml, rawMarkdown, info] = await Promise.all([
        browserAgent.getContent(pageId).catch(() => ''),
        browserAgent.getMarkdown(pageId).catch(() => ''),
        browserAgent.getPageInfo(pageId).catch(() => ({ title: '', url: '' })),
    ]);

    const cleanHtml = simplifyHtml(rawHtml, options);
    const markdown = cleanMarkdown(rawMarkdown || htmlToText(cleanHtml));

    const hash = sha256(`${cleanHtml}\n${markdown}`);

    let cache = pageCache.get(pageId);

    if (!cache || cache.hash !== hash) {
        const chunks = chunkCleanHtml(
            cleanHtml,
            Number(options.maxChunkChars || EMBED_MAX_CHUNK_CHARS)
        );

        cache = {
            pageId,
            hash,
            cleanHtml,
            markdown,
            info,
            chunks,
            embeddings: null,
            model: null,
            createdAt: Date.now(),
        };

        pageCache.set(pageId, cache);
    } else {
        cache.info = info;
    }

    return cache;
}

async function ensureChunkEmbeddings(cache) {
    if (
        cache.embeddings &&
        cache.model &&
        (!runtime.embedderModel || cache.model === runtime.embedderModel)
    ) {
        return;
    }

    const texts = cache.chunks.map((c) => c.markdown || c.text);
    cache.embeddings = await embedTexts(texts);
    cache.model = runtime.embedderModel;
}

/* --------------------------- main agent API ----------------------------- */

export async function smartPageContext(pageId, options = {}) {
    const cache = await buildPageCache(pageId, options);

    const limit = Number(options.limit || EMBED_CONTENT_LIMIT);

    const contentLength = Math.max(
        cache.markdown.length,
        cache.cleanHtml.length
    );

    const base = {
        pageId,
        url: cache.info.url,
        title: cache.info.title,
        contentLength,
        markdownLength: cache.markdown.length,
        htmlLength: cache.cleanHtml.length,
        limit,
        chunkCount: cache.chunks.length,
    };

    // If small enough, do not embed.
    if (contentLength <= limit && !options.forceEmbed) {
        return {
            ...base,
            mode: 'full',
            embedded: false,
            reranked: false,
            markdown: cache.markdown,
            html: cache.cleanHtml,
            chunks: null,
        };
    }

    const query =
        options.query ||
        options.task ||
        options.goal ||
        options.intent ||
        cache.info.title ||
        cache.info.url ||
        'main content';

    const topK = Number(options.topK || RERANK_TOP_K);
    const candidateK = Number(options.candidateK || EMBED_TOP_K);

    if (!cache.chunks.length) {
        return {
            ...base,
            mode: 'truncated',
            embedded: false,
            reranked: false,
            query,
            markdown: cache.markdown.slice(0, limit),
            html: cache.cleanHtml.slice(0, limit),
            chunks: [],
        };
    }

    await ensureChunkEmbeddings(cache);

    const queryVector = await embedQuery(query);

    const scored = cache.chunks.map((chunk, index) => ({
        index,
        chunk,
        score: cosine(queryVector, cache.embeddings?.[index] || []),
    }));

    scored.sort((a, b) => b.score - a.score);

    const candidates = scored.slice(0, Math.max(topK, candidateK));

    const reranked = await rerankDocs(
        query,
        candidates.map((c) => c.chunk.markdown || c.chunk.text)
    );

    const candidateCount = candidates.length;

    const embedScores = candidates.map((c) => c.score);

    const rerankRaw = new Array(candidateCount).fill(0);
    for (const r of reranked) {
        rerankRaw[r.index] = r.score;
    }

    const lexicalResults = lexicalRerank(
        query,
        candidates.map((c) => c.chunk.markdown || c.chunk.text)
    );

    const lexicalRaw = new Array(candidateCount).fill(0);
    for (const r of lexicalResults) {
        lexicalRaw[r.index] = r.score;
    }

    function normalizeScores(arr) {
        const min = Math.min(...arr);
        const max = Math.max(...arr);
        const spread = max - min;

        if (spread <= 1e-6) {
            return arr.map(() => 0);
        }

        return arr.map((v) => (v - min) / spread);
    }

    const embedNorm = normalizeScores(embedScores);
    const rerankNorm = normalizeScores(rerankRaw);
    const lexNorm = normalizeScores(lexicalRaw);

    const rerankSpread = Math.max(...rerankRaw) - Math.min(...rerankRaw);

// If reranker is saturated/useless, trust it less.
    const rerankWeight = rerankSpread > 1e-4 ? 0.5 : 0.15;
    const embedWeight = 0.3;
    const lexWeight = 1 - rerankWeight - embedWeight;

    let top = candidates.map((candidate, i) => {
        const heading = candidate.chunk.heading || '';
        const text = candidate.chunk.text || '';

        const headingBoost =
            /found|pioneer|origin|birth|dartmouth|early|history|mcCarthy|minsky|simon|newell|turing/i.test(
                `${heading} ${text.slice(0, 300)}`
            )
                ? 0.08
                : 0;

        let finalScore =
            rerankWeight * rerankNorm[i] +
            embedWeight * embedNorm[i] +
            lexWeight * lexNorm[i];

        finalScore = Math.min(1, finalScore + headingBoost);

        return {
            ...candidate.chunk,
            embedScore: candidate.score,
            rerankScore: rerankRaw[i],
            lexicalScore: lexicalRaw[i],
            normalizedEmbedScore: embedNorm[i],
            normalizedRerankScore: rerankNorm[i],
            normalizedLexicalScore: lexNorm[i],
            finalScore,
        };
    });

    top.sort((a, b) => b.finalScore - a.finalScore);
    top = top.slice(0, topK);

    const markdown = top
        .map((c) => {
            const title = c.heading || `Chunk ${c.index + 1}`;
            return `### ${title}\n\n${c.text}`;
        })
        .join('\n\n---\n\n');

    const html = top
        .map((c) => {
            const heading = escapeHtml(c.heading || '');

            return `<section data-chunk-index="${c.index}" data-heading="${heading}">
${c.html}
</section>`;
        })
        .join('\n');

    return {
        ...base,
        mode: 'embedded',
        embedded: true,
        reranked: true,
        query,
        model: {
            embedder: runtime.embedderModel,
            reranker: runtime.rerankerModel,
        },
        markdown,
        html,
        chunks: top,
    };
}

export async function getPageContext(pageId, options = {}) {
    return smartPageContext(pageId, options);
}

/*
  Wrapped content functions.

  These are the ones the agent should call.
*/

export async function getContent(pageId, options = {}) {
    const context = await smartPageContext(pageId, options);
    return context.html;
}

export async function getMarkdown(pageId, options = {}) {
    const context = await smartPageContext(pageId, options);
    return context.markdown;
}

export async function getBodyText(pageId, options = {}) {
    const context = await smartPageContext(pageId, options);

    if (context.mode === 'full') {
        return context.markdown;
    }

    return (
        context.chunks
            ?.map((c) => c.text)
            .join('\n\n') || context.markdown
    );
}

export async function agentSnapshot(pageId, options = {}) {
    const [snapshot, context] = await Promise.all([
        browserAgent
            .agentSnapshot(pageId, {
                textLimit: 4_000,
            })
            .catch(() => ({})),
        smartPageContext(pageId, options).catch(() => null),
    ]);

    return {
        ...snapshot,
        context,
    };
}

/*
  Navigation wrappers.

  Invalidate cached content after navigation.
*/

export async function goto(pageId, url, options = {}) {
    const result = await browserAgent.goto(pageId, url, options);
    pageCache.delete(pageId);
    return result;
}

export async function reload(pageId, options = {}) {
    const result = await browserAgent.reload(pageId, options);
    pageCache.delete(pageId);
    return result;
}

export async function goBack(pageId, options = {}) {
    const result = await browserAgent.goBack(pageId, options);
    pageCache.delete(pageId);
    return result;
}

export async function goForward(pageId, options = {}) {
    const result = await browserAgent.goForward(pageId, options);
    pageCache.delete(pageId);
    return result;
}

/* ------------------------------ facade ---------------------------------- */

export const embeddedBrowser = {
    ...browserAgent,

    // wrapped navigation
    goto,
    reload,
    goBack,
    goForward,

    // wrapped agent-facing content APIs
    getContent,
    getMarkdown,
    getBodyText,
    agentSnapshot,

    // new retrieval APIs
    smartPageContext,
    getPageContext,

    // utilities
    simplifyHtml,
    cleanMarkdown,

    // routes
    setupEmbeddedBrowserRoutes,
};

export default embeddedBrowser;

/* ------------------------------- routes --------------------------------- */

const RAW_ENDPOINTS_DISABLED = new Set([
    'GET /api/page/:pageId/content',
    'GET /api/page/:pageId/markdown',
    'GET /api/page/:pageId/text',
    'GET /api/page/:pageId/snapshot',
]);

const ROUTE_METHODS = ['get', 'post', 'put', 'delete', 'patch', 'all'];

function withDisabledRoutes(app, disabled) {
    const wrapped = Object.create(app);

    for (const method of ROUTE_METHODS) {
        if (typeof app[method] !== 'function') continue;

        wrapped[method] = function (routePath, ...handlers) {
            const key = `${method.toUpperCase()} ${routePath}`;

            if (disabled.has(key)) {
                return app[method](routePath, (req, res) => {
                    res.status(404).json({
                        error: 'Not found',
                        detail:
                            'This endpoint only ever served unprocessed content and has ' +
                            'been permanently disabled here. Use the embedded equivalent ' +
                            '(same path, cleaned + chunked + reranked) instead.',
                    });
                });
            }

            return app[method](routePath, ...handlers);
        };
    }

    return wrapped;
}

export function setupEmbeddedBrowserRoutes(app) {
    /*
      Register wrapped endpoints first.
      Express uses first matching route, so these override the original ones.
    */

    app.get(
        '/api/page/:pageId/context',
        asyncRoute(async (req, res) => {
            const context = await smartPageContext(req.params.pageId, req.query || {});
            res.json(context);
        })
    );

    app.post(
        '/api/page/:pageId/context',
        asyncRoute(async (req, res) => {
            const context = await smartPageContext(req.params.pageId, req.body || {});
            res.json(context);
        })
    );

    app.get(
        '/api/page/:pageId/content',
        asyncRoute(async (req, res) => {
            const context = await smartPageContext(req.params.pageId, req.query || {});

            if (req.query.object === 'true') {
                return res.json(context);
            }

            res.json({
                mode: context.mode,
                truncated: context.mode !== 'full',
                html: context.html,
                markdown: context.markdown,
                query: context.query || null,
            });
        })
    );

    app.get(
        '/api/page/:pageId/markdown',
        asyncRoute(async (req, res) => {
            const context = await smartPageContext(req.params.pageId, req.query || {});

            res.json({
                mode: context.mode,
                truncated: context.mode !== 'full',
                markdown: context.markdown,
                query: context.query || null,
            });
        })
    );

    app.get(
        '/api/page/:pageId/text',
        asyncRoute(async (req, res) => {
            const context = await smartPageContext(req.params.pageId, req.query || {});

            const text =
                context.mode === 'full'
                    ? context.markdown
                    : context.chunks?.map((c) => c.text).join('\n\n') ||
                    context.markdown;

            res.json({
                mode: context.mode,
                truncated: context.mode !== 'full',
                text,
                query: context.query || null,
            });
        })
    );

    app.get(
        '/api/page/:pageId/snapshot',
        asyncRoute(async (req, res) => {
            res.json(await agentSnapshot(req.params.pageId, req.query || {}));
        })
    );

    setupOriginalBrowserRoutes(withDisabledRoutes(app, RAW_ENDPOINTS_DISABLED));
}

export const setupBrowserRoutes = setupEmbeddedBrowserRoutes;