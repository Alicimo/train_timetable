#!/usr/bin/env node

const fs = require('fs');
const http = require('http');
const path = require('path');

const {fetchDepartures} = require('./fetch_departures');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 3000;
const DEFAULT_CACHE_TTL_SECONDS = 60;
const DEFAULT_HAFAS_TIMEOUT_SECONDS = 15;

function createDepartureCache(
    loadDepartures,
    ttlMs,
    now = Date.now,
    refreshTimeoutMs = DEFAULT_HAFAS_TIMEOUT_SECONDS * 1000
) {
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
                        reject(new Error('HAFAS refresh timed out'));
                    }, refreshTimeoutMs);
                });

                refresh = Promise.race([
                    Promise.resolve().then(() => loadDepartures({signal: controller.signal})),
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

function createServer({
    loadDepartures = fetchDepartures,
    cacheTtlMs = DEFAULT_CACHE_TTL_SECONDS * 1000,
    refreshTimeoutMs = DEFAULT_HAFAS_TIMEOUT_SECONDS * 1000,
    now = Date.now,
    indexHtml = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8'),
    logger = console
} = {}) {
    const cache = createDepartureCache(loadDepartures, cacheTtlMs, now, refreshTimeoutMs);

    return http.createServer(async (req, res) => {
        const requestUrl = new URL(req.url, 'http://localhost');

        if (req.method === 'GET' && (requestUrl.pathname === '/' || requestUrl.pathname === '/index.html')) {
            send(res, 200, {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'no-cache',
                'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; connect-src 'self'",
                'Referrer-Policy': 'no-referrer'
            }, indexHtml);
            return;
        }

        if (req.method === 'GET' && requestUrl.pathname === '/healthz') {
            sendJson(res, 200, {status: 'ok'});
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

        sendJson(res, 404, {error: 'Not found'});
    });
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

if (require.main === module) {
    const host = process.env.HOST || DEFAULT_HOST;
    const port = readPositiveInteger('PORT', DEFAULT_PORT);
    const cacheTtlSeconds = readPositiveInteger('CACHE_TTL_SECONDS', DEFAULT_CACHE_TTL_SECONDS);
    const hafasTimeoutSeconds = readPositiveInteger('HAFAS_TIMEOUT_SECONDS', DEFAULT_HAFAS_TIMEOUT_SECONDS);
    const server = createServer({
        cacheTtlMs: cacheTtlSeconds * 1000,
        refreshTimeoutMs: hafasTimeoutSeconds * 1000
    });

    server.listen(port, host, () => {
        console.log(`Train updates listening on http://${host}:${port}`);
    });

    const shutdown = () => server.close(() => process.exit(0));
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

module.exports = {createDepartureCache, createServer};
