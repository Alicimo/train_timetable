const assert = require('node:assert/strict');
const {once} = require('node:events');
const fs = require('node:fs/promises');
const {tmpdir} = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {setTimeout: delay} = require('node:timers/promises');

const {departureTiming} = require('./fetch_departures');
const {createDepartureCache, createServer} = require('./server');
const {createTelegramSettings} = require('./telegram_settings');

const defaultSchedule = {days: [0, 1, 2, 3, 4, 5, 6], windows: []};
const defaultPreferences = {schedule: defaultSchedule, minimumDelayMinutes: 10};

const sampleDepartures = {
    badVoeslauToWien: [],
    wienToBadVoeslau: [],
    lastUpdated: '2026-08-31T12:00:00.000Z',
    stations: {
        badVoeslau: {name: 'Bad Vöslau', id: '1'},
        wienHbf: {name: 'Wien Hbf', id: '2'}
    }
};
const clearU1 = {checkedAt: '2026-11-23T05:21:56.000Z', notices: []};

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
    const server = createServer({loadU1Status: async () => clearU1, ...options});
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

test('the server records a departure at startup without Telegram or dashboard traffic', {timeout: 2000}, async (t) => {
    const historyDirectory = await fs.mkdtemp(path.join(tmpdir(), 'train-delay-server-'));
    t.after(() => fs.rm(historyDirectory, {recursive: true, force: true}));
    let loads = 0;
    const publicTrain = {pr: 'REX 1', delay: 60, cancelled: false};
    const plannedAt = Date.parse(sampleDepartures.lastUpdated) + 60_000;
    const baseUrl = await startTestServer(t, {
        historyDirectory,
        async loadDepartures() {
            loads += 1;
            return {
                ...sampleDepartures,
                badVoeslauToWien: [{
                    ...publicTrain,
                    [departureTiming]: {tripId: 'trip', trainNumber: '2307', plannedAt}
                }]
            };
        }
    });

    const file = path.join(historyDirectory, '2026-08-31.jsonl');
    const deadline = AbortSignal.timeout(1000);
    let contents = '';
    while (!contents.endsWith('\n')) {
        contents = await fs.readFile(file, 'utf8').catch((error) => {
            if (error.code !== 'ENOENT') {
                throw error;
            }
            return '';
        });
        if (!contents.endsWith('\n')) {
            await delay(10, undefined, {signal: deadline});
        }
    }
    assert.equal(JSON.parse(contents).trainNumber, '2307');

    const response = await fetch(`${baseUrl}/api/departures`);
    assert.deepEqual(await response.json(), {...sampleDepartures, badVoeslauToWien: [publicTrain]});
    assert.equal(loads, 1);
});

test('U1 endpoint can serve fresh and stale snapshots independently of departures', async (t) => {
    let currentTime = 0;
    let attempts = 0;
    let aborted = false;
    const baseUrl = await startTestServer(t, {
        now: () => currentTime,
        u1TimeoutMs: 10,
        loadDepartures: async () => { throw new Error('ÖBB offline'); },
        loadU1Status({signal}) {
            if (++attempts === 1) {
                return clearU1;
            }
            return new Promise(() => {
                signal.addEventListener('abort', () => { aborted = true; });
            });
        },
        logger: {error() {}}
    });
    const getU1 = async () => (await fetch(`${baseUrl}/api/u1-status`)).json();

    assert.equal((await fetch(`${baseUrl}/api/departures`)).status, 502);
    assert.deepEqual(await getU1(), {...clearU1, stale: false});
    assert.deepEqual(await getU1(), {...clearU1, stale: false});
    currentTime = 60_000;
    assert.deepEqual(await getU1(), {...clearU1, stale: true});
    assert.equal(aborted, true);
    assert.equal(attempts, 2);
});

test('U1 Telegram alerts and the endpoint share a refresh even if ÖBB fails', {timeout: 2000}, async (t) => {
    let loads = 0;
    let finishLoad;
    let finishAlert;
    const pendingLoad = new Promise((resolve) => { finishLoad = resolve; });
    const alert = new Promise((resolve) => { finishAlert = resolve; });
    const baseUrl = await startTestServer(t, {
        loadDepartures: async () => { throw new Error('ÖBB offline'); },
        loadU1Status() {
            loads += 1;
            return pendingLoad;
        },
        telegramSendMessage: finishAlert,
        logger: {error() {}}
    });
    const response = fetch(`${baseUrl}/api/u1-status`);
    finishLoad({...clearU1, notices: [{id: 'closure', detailed: true, title: 'Kein Betrieb'}]});
    assert.match(await alert, /U1 service notice · Kein Betrieb/);
    assert.equal((await response).status, 200);
    assert.equal(loads, 1);
});

test('initial U1 failure leaves the departure board available', async (t) => {
    const baseUrl = await startTestServer(t, {
        loadDepartures: async () => sampleDepartures,
        loadU1Status: async () => { throw new Error('Wiener Linien offline'); },
        logger: {error() {}}
    });
    const response = await fetch(`${baseUrl}/api/u1-status`);
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), {error: 'Unable to fetch U1 status'});
    assert.equal((await fetch(`${baseUrl}/api/departures`)).status, 200);
});

test('dashboard links to a 180×180 iOS Home Screen icon', async (t) => {
    const baseUrl = await startTestServer(t);

    for (const pagePath of ['/', '/index.html']) {
        const response = await fetch(new URL(pagePath, baseUrl));
        assert.equal(response.status, 200);
        assert.match(await response.text(),
            /<link rel="apple-touch-icon" sizes="180x180" href="\/apple-touch-icon\.png" \/>/);
    }

    const icon = await fetch(new URL('/apple-touch-icon.png', baseUrl));
    assert.equal(icon.status, 200);
    assert.equal(icon.headers.get('content-type'), 'image/png');
    const png = Buffer.from(await icon.arrayBuffer());
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(png.toString('ascii', 12, 16), 'IHDR');
    assert.equal(png.readUInt32BE(16), 180);
    assert.equal(png.readUInt32BE(20), 180);
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

test('Telegram startup check and the departure API share an in-flight refresh', {timeout: 2000}, async (t) => {
    const now = Date.parse(sampleDepartures.lastUpdated);
    let loads = 0;
    let finishLoad;
    let finishAlert;
    const pendingLoad = new Promise((resolve) => {
        finishLoad = resolve;
    });
    const alert = new Promise((resolve) => {
        finishAlert = resolve;
    });
    const server = createServer({
        now: () => now,
        loadU1Status: async () => clearU1,
        loadDepartures() {
            loads += 1;
            return pendingLoad;
        },
        telegramSendMessage: finishAlert
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => server.close());

    const requestSeen = once(server, 'request');
    const responsePending = fetch(`http://127.0.0.1:${server.address().port}/api/departures`);
    await requestSeen;
    assert.equal(loads, 1);

    const publicTrain = {pr: 'REX 1', delay: 600, cancelled: false};
    finishLoad({
        ...sampleDepartures,
        badVoeslauToWien: [{
            ...publicTrain,
            [departureTiming]: {tripId: 'trip', plannedAt: now, expectedAt: now + 600_000}
        }]
    });

    assert.match(await alert, /delayed 10 min/);
    const response = await responsePending;
    assert.deepEqual((await response.json()).badVoeslauToWien, [publicTrain]);
    assert.equal(loads, 1);
});

async function telegramFixture(t, env = {}, acceptsMessage = (message) => message.chat_id !== '-999') {
    const directory = await fs.mkdtemp(path.join(tmpdir(), 'train-telegram-test-'));
    t.after(() => fs.rm(directory, {recursive: true, force: true}));
    const messages = [];
    const options = {
        directory,
        env,
        async request(url, {body}) {
            const message = JSON.parse(body);
            messages.push({url, ...message});
            return Response.json({ok: acceptsMessage(message)});
        }
    };
    async function start(extraServerOptions = {}) {
        const baseUrl = await startTestServer(t, {
            loadDepartures: async () => sampleDepartures,
            telegramSettings: await createTelegramSettings(options),
            ...extraServerOptions
        });
        const url = `${baseUrl}/api/telegram-settings`;
        return {
            status: async () => (await fetch(url)).json(),
            save: (input, headers = {}) => fetch(url, {
                method: 'PUT',
                headers: {'Content-Type': 'application/json', ...headers},
                body: JSON.stringify(input)
            })
        };
    }
    return {start, messages, file: path.join(directory, 'telegram.json')};
}

test('configure, update, rotate, and re-enable Telegram using the dashboard API', async (t) => {
    const {start, messages, file} = await telegramFixture(t);
    const now = Date.parse(sampleDepartures.lastUpdated);
    const api = await start({
        now: () => now,
        loadDepartures: async () => ({
            ...sampleDepartures,
            badVoeslauToWien: [{
                pr: 'REX 1',
                delay: 600,
                cancelled: false,
                [departureTiming]: {tripId: 'trip', plannedAt: now, expectedAt: now + 600_000}
            }]
        })
    });
    assert.deepEqual(await api.status(), {enabled: false, chatId: null, hasToken: false, ...defaultPreferences});

    const configured = {enabled: true, chatId: '-123', hasToken: true, ...defaultPreferences};
    const setup = await api.save({enabled: true, chatId: '-123', botToken: '1:mock-token'});
    assert.equal(setup.status, 200);
    assert.deepEqual(await setup.json(), configured);
    assert.equal(messages[0].text, 'Train updates · Telegram alerts test\nhttps://trains.alistair-martin.com');
    assert.equal(messages[1].text,
        'Bad Vöslau → Wien Hbf · REX 1 14:00 · delayed 10 min\nhttps://trains.alistair-martin.com');
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    assert.deepEqual(await (await start()).status(), configured);

    const moved = await api.save({enabled: true, chatId: '-456'});
    assert.equal(moved.status, 200);
    assert.deepEqual(await moved.json(), {...configured, chatId: '-456'});
    assert.equal(messages.at(-1).chat_id, '-456');
    assert.match(messages.at(-1).url, /bot1:mock-token\/sendMessage$/);

    const rotated = await api.save({enabled: true, chatId: '-456', botToken: '2:new-token'});
    assert.equal(rotated.status, 200);
    assert.match(messages.at(-1).url, /bot2:new-token\/sendMessage$/);

    const beforeDisable = messages.length;
    const disabled = await api.save({enabled: false});
    assert.deepEqual(await disabled.json(), {enabled: false, chatId: '-456', hasToken: true, ...defaultPreferences});
    assert.equal(messages.length, beforeDisable + 1);
    assert.deepEqual(messages.at(-1), {
        url: 'https://api.telegram.org/bot2:new-token/sendMessage',
        chat_id: '-456',
        text: 'Train updates · Telegram alerts have been disabled.\nhttps://trains.alistair-martin.com',
        link_preview_options: {is_disabled: true}
    });
    assert.equal((await api.save({enabled: false})).status, 200);
    assert.equal(messages.length, beforeDisable + 1);
    const restarted = await start();
    assert.deepEqual(await restarted.status(), {enabled: false, chatId: '-456', hasToken: true, ...defaultPreferences});
    const reenabled = await restarted.save({enabled: true, chatId: '-456'});
    assert.equal(reenabled.status, 200);
    assert.match(messages.at(-1).url, /bot2:new-token\/sendMessage$/);
});

test('alerts stay disabled when Telegram rejects the disable confirmation', async (t) => {
    const {start, messages} = await telegramFixture(t, {
        TELEGRAM_BOT_TOKEN: '1:seed',
        TELEGRAM_CHAT_ID: '123'
    }, () => false);
    const api = await start();
    const response = await api.save({enabled: false});
    assert.equal(response.status, 200);
    const disabled = {enabled: false, chatId: '123', hasToken: true, ...defaultPreferences};
    assert.deepEqual(await response.json(), {
        ...disabled,
        warning: 'Alerts are disabled, but Telegram could not deliver the confirmation.'
    });
    assert.match(messages[0].text, /alerts have been disabled/);
    assert.deepEqual(await (await start()).status(), disabled);
});

test('persisted settings beat the deployment seed, including after disabling', async (t) => {
    const {start, messages} = await telegramFixture(t, {
        TELEGRAM_BOT_TOKEN: '1:seed',
        TELEGRAM_CHAT_ID: '123'
    });
    const api = await start();
    assert.deepEqual(await api.status(), {enabled: true, chatId: '123', hasToken: true, ...defaultPreferences});
    assert.equal(messages.length, 0);

    assert.equal((await api.save({enabled: true, chatId: '456'})).status, 200);
    assert.equal((await api.save({enabled: false})).status, 200);
    assert.deepEqual(await (await start()).status(), {enabled: false, chatId: '456', hasToken: true, ...defaultPreferences});
});

test('failed test sends and failed writes preserve active settings', async (t) => {
    const {start, file} = await telegramFixture(t, {
        TELEGRAM_BOT_TOKEN: '1:seed',
        TELEGRAM_CHAT_ID: '123'
    });
    const api = await start();
    const original = await fs.readFile(file, 'utf8');
    const rejected = await api.save({enabled: true, chatId: '-999', botToken: '2:rejected'});
    assert.equal(rejected.status, 502);
    assert.doesNotMatch(await rejected.text(), /2:rejected/);
    assert.equal(await fs.readFile(file, 'utf8'), original);
    assert.deepEqual(await api.status(), {enabled: true, chatId: '123', hasToken: true, ...defaultPreferences});

    await fs.rename(file, `${file}.backup`);
    await fs.mkdir(file);
    const failedWrite = await api.save({enabled: true, chatId: '-456'});
    assert.equal(failedWrite.status, 500);
    assert.deepEqual(await api.status(), {enabled: true, chatId: '123', hasToken: true, ...defaultPreferences});
});

test('invalid seed and corrupt state leave the departure service usable and allow repair', async (t) => {
    const {start, file} = await telegramFixture(t, {TELEGRAM_CHAT_ID: '123'});
    const api = await start();
    assert.match((await api.status()).issue, /initial Telegram settings are invalid/);

    await fs.writeFile(file, '{bad JSON');
    const restarted = await start();
    const status = await restarted.status();
    assert.equal(status.enabled, false);
    assert.match(status.issue, /Could not read saved Telegram settings/);
    assert.equal((await restarted.save({enabled: true, chatId: '456', botToken: '1:fixed'})).status, 200);
    assert.deepEqual(await restarted.status(), {enabled: true, chatId: '456', hasToken: true, ...defaultPreferences});
});

test('Telegram settings reject cross-origin, oversized, and invalid writes', async (t) => {
    const {start, messages} = await telegramFixture(t);
    const api = await start();
    const input = {enabled: true, chatId: '123', botToken: '1:mock'};
    assert.equal((await api.save(input, {Origin: 'https://example.com'})).status, 403);
    assert.equal((await api.save(input, {'Sec-Fetch-Site': 'same-site'})).status, 403);
    assert.equal((await api.save(input, {'Content-Type': 'text/plain'})).status, 415);
    assert.equal((await api.save({...input, botToken: 'b'.repeat(4096)})).status, 413);
    assert.equal((await api.save({...input, chatId: 'not-a-chat'})).status, 400);
    assert.deepEqual(messages, []);
});


test('notification preferences preserve legacy Telegram settings and persist without sending a test', async (t) => {
    const {start, messages, file} = await telegramFixture(t);
    await fs.writeFile(file, JSON.stringify({enabled: true, chatId: '123', botToken: '1:legacy'}));
    const api = await start();
    assert.deepEqual(await api.status(), {
        enabled: true, chatId: '123', hasToken: true, ...defaultPreferences
    });

    const schedule = {days: [0], windows: [
        {start: '07:00', end: '09:00', direction: 'badVoeslauToWien'},
        {start: '16:00', end: '18:00', direction: 'wienToBadVoeslau'}
    ]};
    const result = await api.save({schedule, minimumDelayMinutes: 15});
    assert.equal(result.status, 200);
    const configured = {enabled: true, chatId: '123', hasToken: true, schedule, minimumDelayMinutes: 15};
    assert.deepEqual(await result.json(), configured);
    assert.deepEqual(messages, []);
    assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).botToken, '1:legacy');

    for (const invalid of [
        null,
        {days: [7], windows: []},
        {days: [0], windows: [{start: '24:00', end: '08:00'}]},
        {days: [0], windows: [{start: '08:00', end: '08:00'}]},
        {days: [0], windows: [{start: '08:00', end: '09:00'}]},
        {days: [0], windows: [{start: '08:00', end: '09:00', direction: 'unknown'}]}
    ]) {
        assert.equal((await api.save({schedule: invalid})).status, 400);
    }
    for (const invalid of [null, 0, -5, 12, 12.5, '15']) {
        assert.equal((await api.save({minimumDelayMinutes: invalid})).status, 400);
    }
    assert.deepEqual(await (await start()).status(), configured);

    assert.equal((await api.save({enabled: false})).status, 200);
    const paused = {days: [], windows: []};
    assert.equal((await api.save({schedule: paused})).status, 200);
    assert.deepEqual(await api.status(), {...configured, enabled: false, schedule: paused});
    assert.equal((await api.save({enabled: true, chatId: '123'})).status, 200);
    assert.deepEqual(await api.status(), {...configured, schedule: paused});
    assert.deepEqual(messages.map(({text}) => text), [
        'Train updates · Telegram alerts have been disabled.\nhttps://trains.alistair-martin.com',
        'Train updates · Telegram alerts test\nhttps://trains.alistair-martin.com'
    ]);
});

test('saving the minimum applies it to an in-flight Telegram poll', async (t) => {
    const {start, messages} = await telegramFixture(t, {
        TELEGRAM_BOT_TOKEN: '1:seed',
        TELEGRAM_CHAT_ID: '123'
    });
    const now = Date.parse(sampleDepartures.lastUpdated);
    const {promise: pendingLoad, resolve: finishLoad} = Promise.withResolvers();
    const api = await start({
        now: () => now,
        loadDepartures: () => pendingLoad,
        loadU1Status: async () => clearU1
    });

    const result = await api.save({minimumDelayMinutes: 5});
    assert.equal(result.status, 200);
    assert.equal((await result.json()).minimumDelayMinutes, 5);
    assert.deepEqual(messages, []);
    finishLoad({
        ...sampleDepartures,
        badVoeslauToWien: [{
            pr: 'REX 1',
            delay: 360,
            cancelled: false,
            [departureTiming]: {tripId: 'trip', plannedAt: now, expectedAt: now + 360_000}
        }]
    });

    await api.status();
    assert.equal(messages.length, 1);
    assert.equal(messages[0].text,
        'Bad Vöslau → Wien Hbf · REX 1 14:00 · delayed 6 min\nhttps://trains.alistair-martin.com');
});

test('saved notification windows filter alerts by direction and Vienna local time', async (t) => {
    const {start, messages, file} = await telegramFixture(t);
    const schedule = {
        days: [6],
        windows: [
            {start: '07:00', end: '09:00', direction: 'badVoeslauToWien'},
            {start: '13:00', end: '14:00'},
            {start: '15:00', end: '16:00', direction: 'both'},
            {start: '22:00', end: '02:00', direction: 'wienToBadVoeslau'}
        ]
    };
    await fs.writeFile(file, JSON.stringify({enabled: true, chatId: '123', botToken: '1:legacy', schedule}));
    const inbound = 'Bad Vöslau → Wien Hbf';
    const outbound = 'Wien Hbf → Bad Vöslau';

    for (const [timestamp, expectedRoutes] of [
        ['2026-08-30T04:59:59Z', []], // Sunday 06:59:59
        ['2026-08-30T05:00:00Z', [inbound]], // Sunday 07:00 in summer
        ['2026-11-22T06:00:00Z', [inbound]], // Sunday 07:00 in winter
        ['2026-08-30T07:00:00Z', []], // Sunday 09:00
        ['2026-08-30T11:00:00Z', []], // Sunday 13:00, discarded window
        ['2026-08-30T13:00:00Z', [inbound, outbound]], // Sunday 15:00
        ['2026-08-30T21:00:00Z', [outbound]], // Sunday 23:00
        ['2026-08-30T23:59:59Z', [outbound]], // Monday 01:59:59
        ['2026-08-31T00:00:00Z', []], // Monday 02:00
        ['2026-08-31T05:00:00Z', []] // Monday 07:00
    ]) {
        messages.length = 0;
        const now = Date.parse(timestamp);
        const train = {
            pr: 'REX 1',
            delay: 600,
            cancelled: false,
            [departureTiming]: {tripId: 'trip', plannedAt: now, expectedAt: now + 600_000}
        };
        let polled = false;
        let u1Polled = false;
        const restarted = await start({
            now: () => now,
            async loadDepartures() {
                polled = true;
                return {...sampleDepartures, badVoeslauToWien: [train], wienToBadVoeslau: [train]};
            },
            async loadU1Status() {
                u1Polled = true;
                return {...clearU1, notices: [{id: 'delay', detailed: true, title: 'Verspätungen'}]};
            }
        });
        const status = await restarted.status();
        assert.deepEqual(status.schedule, {
            days: [6], windows: schedule.windows.filter((window) => window.direction)
        });
        assert.equal(polled, expectedRoutes.length > 0, timestamp);
        assert.equal(u1Polled, expectedRoutes.length > 0, timestamp);
        const routes = messages.map(({text}) => text.split(' · ')[0]);
        assert.deepEqual(routes.filter((route) => route !== 'U1 service notice'), expectedRoutes, timestamp);
        assert.equal(routes.filter((route) => route === 'U1 service notice').length,
            Number(expectedRoutes.length > 0), timestamp);
    }
});
