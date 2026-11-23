#!/usr/bin/env node

const fs = require('fs');
const http = require('http');
const path = require('path');

const {fetchDepartures} = require('./fetch_departures');
const {startTelegramAlerts} = require('./telegram_alerts');
const {createTelegramSettings, TelegramSettingsError} = require('./telegram_settings');
const {fetchU1Status} = require('./u1_status');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 3000;
const DEFAULT_CACHE_TTL_SECONDS = 60;
const DEFAULT_HAFAS_TIMEOUT_SECONDS = 15;
const U1_CACHE_TTL_MS = 60_000;
const U1_TIMEOUT_MS = 5_000;
const SETTINGS_BODY_LIMIT = 4096;

function createDepartureCache(
    loadDepartures,
    ttlMs,
    now = Date.now,
    refreshTimeoutMs = DEFAULT_HAFAS_TIMEOUT_SECONDS * 1000
) {
    return createRefreshCache(loadDepartures, ttlMs, now, refreshTimeoutMs, 'HAFAS');
}

function createRefreshCache(load, ttlMs, now, refreshTimeoutMs, source) {
    let cachedData = null;
    let expiresAt = 0;
    let refresh = null;

    return {
        async get() {
            if (cachedData && now() < expiresAt) {
                return {data: cachedData, stale: false};
            }

            if (!refresh) {
                const controller = new AbortController();
                let timeout;
                const deadline = new Promise((_, reject) => {
                    timeout = setTimeout(() => {
                        controller.abort();
                        reject(new Error(`${source} refresh timed out`));
                    }, refreshTimeoutMs);
                });

                refresh = Promise.race([
                    Promise.resolve().then(() => load({signal: controller.signal})),
                    deadline
                ])
                    .then((data) => {
                        cachedData = data;
                        expiresAt = now() + ttlMs;
                        return data;
                    })
                    .finally(() => {
                        clearTimeout(timeout);
                        refresh = null;
                    });
            }

            try {
                return {data: await refresh, stale: false};
            } catch (error) {
                if (cachedData) {
                    return {data: cachedData, stale: true};
                }
                throw error;
            }
        }
    };
}

function send(res, statusCode, headers, body = '') {
    res.writeHead(statusCode, {
        'X-Content-Type-Options': 'nosniff',
        ...headers
    });
    res.end(body);
}

function sendJson(res, statusCode, value, headers = {}) {
    send(res, statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        ...headers
    }, JSON.stringify(value));
}

function isSameOriginWrite(req) {
    const site = req.headers['sec-fetch-site'];
    if (site) {
        return site === 'same-origin';
    }
    const origin = req.headers.origin;
    return !origin || origin === `https://${req.headers.host}` || origin === `http://${req.headers.host}`;
}

async function readSettingsBody(req) {
    if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
        throw new TelegramSettingsError(415, 'Telegram settings require a JSON request.');
    }

    const chunks = [];
    let size = 0;
    for await (const chunk of req.iterator({destroyOnReturn: false})) {
        size += chunk.length;
        if (size > SETTINGS_BODY_LIMIT) {
            req.resume();
            throw new TelegramSettingsError(413, 'Telegram settings request is too large.');
        }
        chunks.push(chunk);
    }

    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
        throw new TelegramSettingsError(400, 'Telegram settings request contains invalid JSON.');
    }
}

function createServer({
    loadDepartures = fetchDepartures,
    loadU1Status = fetchU1Status,
    cacheTtlMs = DEFAULT_CACHE_TTL_SECONDS * 1000,
    refreshTimeoutMs = DEFAULT_HAFAS_TIMEOUT_SECONDS * 1000,
    u1TimeoutMs = U1_TIMEOUT_MS,
    now = Date.now,
    indexHtml = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8'),
    logger = console,
    telegramSendMessage,
    telegramSettings
} = {}) {
    const cache = createDepartureCache(loadDepartures, cacheTtlMs, now, refreshTimeoutMs);
    const u1Cache = createRefreshCache(
        ({signal}) => loadU1Status({signal, now}), U1_CACHE_TTL_MS, now, u1TimeoutMs, 'Wiener Linien'
    );
    const appleTouchIcon = fs.readFileSync(path.join(__dirname, 'apple-touch-icon.png'));

    let stopTelegramAlerts;
    function applyTelegramSender(sendMessage) {
        stopTelegramAlerts?.();
        stopTelegramAlerts = sendMessage && startTelegramAlerts({
            getDepartures: () => cache.get(),
            getU1Status: () => u1Cache.get(),
            sendMessage,
            allowsAlerts: telegramSettings?.allowsAlerts,
            now,
            logger
        });
    }

    const server = http.createServer(async (req, res) => {
        const requestUrl = new URL(req.url, 'http://localhost');

        if (req.method === 'GET' && (requestUrl.pathname === '/' || requestUrl.pathname === '/index.html')) {
            send(res, 200, {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'no-cache',
                'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; connect-src 'self'; frame-ancestors 'none'",
                'Referrer-Policy': 'no-referrer'
            }, indexHtml);
            return;
        }

        if (req.method === 'GET' && requestUrl.pathname === '/apple-touch-icon.png') {
            send(res, 200, {
                'Content-Type': 'image/png',
                'Cache-Control': 'no-cache'
            }, appleTouchIcon);
            return;
        }

        if (req.method === 'GET' && requestUrl.pathname === '/healthz') {
            sendJson(res, 200, {status: 'ok'});
            return;
        }

        if (telegramSettings && requestUrl.pathname === '/api/telegram-settings') {
            if (req.method === 'GET') {
                sendJson(res, 200, telegramSettings.status());
                return;
            }
            if (req.method === 'PUT') {
                if (!isSameOriginWrite(req)) {
                    sendJson(res, 403, {error: 'Open the train dashboard to update Telegram settings.'});
                    return;
                }
                try {
                    const input = await readSettingsBody(req);
                    sendJson(res, 200, await telegramSettings.update(input, applyTelegramSender));
                } catch (error) {
                    if (error instanceof TelegramSettingsError) {
                        sendJson(res, error.status, {error: error.message});
                    } else {
                        logger.error('Telegram settings request failed');
                        sendJson(res, 500, {error: 'Could not update Telegram settings.'});
                    }
                }
                return;
            }
            sendJson(res, 405, {error: 'Method not allowed'}, {Allow: 'GET, PUT'});
            return;
        }

        if (req.method === 'GET' && requestUrl.pathname === '/api/departures') {
            try {
                const result = await cache.get();
                const headers = result.stale
                    ? {'Warning': '110 - "Response is stale"', 'X-Data-Stale': 'true'}
                    : {'X-Data-Stale': 'false'};
                sendJson(res, 200, result.data, headers);
            } catch (error) {
                logger.error('Failed to refresh departures:', error);
                sendJson(res, 502, {error: 'Unable to fetch departures'});
            }
            return;
        }

        if (req.method === 'GET' && requestUrl.pathname === '/api/u1-status') {
            try {
                const {data, stale} = await u1Cache.get();
                sendJson(res, 200, {...data, stale});
            } catch (error) {
                logger.error('Failed to refresh U1 status:', error);
                sendJson(res, 502, {error: 'Unable to fetch U1 status'});
            }
            return;
        }

        sendJson(res, 404, {error: 'Not found'});
    });

    server.on('listening', () => applyTelegramSender(telegramSettings?.sender() ?? telegramSendMessage));
    server.once('close', () => stopTelegramAlerts?.());

    return server;
}

function readPositiveInteger(name, fallback) {
    const rawValue = process.env[name];
    if (rawValue === undefined) {
        return fallback;
    }

    const value = Number(rawValue);
    if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`${name} must be a positive integer`);
    }
    return value;
}

async function main() {
    const host = process.env.HOST || DEFAULT_HOST;
    const port = readPositiveInteger('PORT', DEFAULT_PORT);
    const cacheTtlSeconds = readPositiveInteger('CACHE_TTL_SECONDS', DEFAULT_CACHE_TTL_SECONDS);
    const hafasTimeoutSeconds = readPositiveInteger('HAFAS_TIMEOUT_SECONDS', DEFAULT_HAFAS_TIMEOUT_SECONDS);
    const telegramSettings = await createTelegramSettings({
        directory: process.env.STATE_DIRECTORY || path.resolve('.train-updates-state')
    });
    const server = createServer({
        cacheTtlMs: cacheTtlSeconds * 1000,
        refreshTimeoutMs: hafasTimeoutSeconds * 1000,
        telegramSettings
    });

    server.listen(port, host, () => {
        console.log(`Train updates listening on http://${host}:${port}`);
    });

    const shutdown = () => server.close(() => process.exit(0));
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

if (require.main === module) {
    main().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}

module.exports = {createDepartureCache, createServer};
