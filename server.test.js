const assert = require('node:assert/strict');
const {once} = require('node:events');
const test = require('node:test');

const {createDepartureCache, createServer} = require('./server');

const sampleDepartures = {
    badVoeslauToWien: [],
    wienToBadVoeslau: [],
    lastUpdated: '2026-08-31T12:00:00.000Z',
    stations: {
        badVoeslau: {name: 'Bad Vöslau', id: '1'},
        wienHbf: {name: 'Wien Hbf', id: '2'}
    }
};

test('departure cache reuses fresh data and refreshes expired data', async () => {
    let currentTime = 0;
    let calls = 0;
    const cache = createDepartureCache(
        async () => ({version: ++calls}),
        100,
        () => currentTime
    );

    assert.deepEqual(await cache.get(), {data: {version: 1}, stale: false});
    assert.deepEqual(await cache.get(), {data: {version: 1}, stale: false});

    currentTime = 101;
    assert.deepEqual(await cache.get(), {data: {version: 2}, stale: false});
    assert.equal(calls, 2);
});

test('departure cache coalesces concurrent refreshes', async () => {
    let calls = 0;
    let finishLoad;
    const pendingLoad = new Promise((resolve) => {
        finishLoad = resolve;
    });
    const cache = createDepartureCache(() => {
        calls += 1;
        return pendingLoad;
    }, 100);

    const first = cache.get();
    const second = cache.get();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(calls, 1);
    finishLoad({version: 1});
    assert.deepEqual(await Promise.all([first, second]), [
        {data: {version: 1}, stale: false},
        {data: {version: 1}, stale: false}
    ]);
});

test('departure cache serves stale data when a refresh fails', async () => {
    let currentTime = 0;
    let shouldFail = false;
    const cache = createDepartureCache(async () => {
        if (shouldFail) {
            throw new Error('upstream unavailable');
        }
        return {version: 1};
    }, 100, () => currentTime);

    await cache.get();
    currentTime = 101;
    shouldFail = true;

    assert.deepEqual(await cache.get(), {data: {version: 1}, stale: true});
});

async function startTestServer(t, options) {
    const server = createServer(options);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => server.close());

    const {port} = server.address();
    return `http://127.0.0.1:${port}`;
}

test('server exposes the page, health check, and departure API', async (t) => {
    const baseUrl = await startTestServer(t, {
        indexHtml: '<!doctype html><title>Train updates</title>',
        loadDepartures: async () => sampleDepartures
    });

    const pageResponse = await fetch(`${baseUrl}/`);
    assert.equal(pageResponse.status, 200);
    assert.match(await pageResponse.text(), /Train updates/);

    const healthResponse = await fetch(`${baseUrl}/healthz`);
    assert.deepEqual(await healthResponse.json(), {status: 'ok'});

    const departuresResponse = await fetch(`${baseUrl}/api/departures`);
    assert.equal(departuresResponse.headers.get('x-data-stale'), 'false');
    assert.deepEqual(await departuresResponse.json(), sampleDepartures);

    const missingResponse = await fetch(`${baseUrl}/missing`);
    assert.equal(missingResponse.status, 404);
});

test('server serves stale data when a timed-out refresh follows a success', async (t) => {
    let currentTime = 0;
    let calls = 0;
    let aborted = false;
    const baseUrl = await startTestServer(t, {
        indexHtml: '',
        cacheTtlMs: 100,
        refreshTimeoutMs: 5,
        now: () => currentTime,
        loadDepartures: ({signal}) => {
            calls += 1;
            if (calls === 1) {
                return sampleDepartures;
            }
            return new Promise((resolve, reject) => {
                signal.addEventListener('abort', () => {
                    aborted = true;
                    reject(new Error('aborted'));
                });
            });
        }
    });

    const freshResponse = await fetch(`${baseUrl}/api/departures`);
    assert.equal(freshResponse.headers.get('x-data-stale'), 'false');
    await freshResponse.body.cancel();

    currentTime = 101;
    const staleResponse = await fetch(`${baseUrl}/api/departures`);
    assert.equal(staleResponse.status, 200);
    assert.equal(staleResponse.headers.get('x-data-stale'), 'true');
    assert.equal(staleResponse.headers.get('warning'), '110 - "Response is stale"');
    assert.deepEqual(await staleResponse.json(), sampleDepartures);
    assert.equal(aborted, true);
});

test('server aborts a timed-out initial refresh and reports failure', async (t) => {
    let aborted = false;
    const baseUrl = await startTestServer(t, {
        indexHtml: '',
        refreshTimeoutMs: 5,
        loadDepartures: ({signal}) => {
            return new Promise((resolve, reject) => {
                signal.addEventListener('abort', () => {
                    aborted = true;
                    reject(new Error('aborted'));
                });
            });
        },
        logger: {error() {}}
    });

    const response = await fetch(`${baseUrl}/api/departures`);
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), {error: 'Unable to fetch departures'});
    assert.equal(aborted, true);
});
