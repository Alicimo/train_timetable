const assert = require('node:assert/strict');
const test = require('node:test');

const {departureTiming} = require('./fetch_departures');
const {createTelegramPoll, createU1TelegramPoll, createTelegramSender} = require('./telegram_alerts');

const now = Date.parse('2026-08-31T08:00:00Z');

test('U1 poll retries detailed alerts within the schedule and skips stale or short notices', async () => {
    const attempts = [];
    const errors = [];
    let allowed = false;
    let loads = 0;
    const snapshot = {
        stale: true,
        data: {notices: [
            {id: 'short', detailed: false, title: 'Kein Betrieb'},
            {id: 'expired', detailed: true, title: 'Expired', endsAt: new Date(now).toISOString()},
            {id: 'delay', detailed: true, title: 'U1: Verspätungen', description: 'Unregelmäßige Intervalle.'}
        ]}
    };
    const poll = createU1TelegramPoll({
        getU1Status: async () => {
            loads += 1;
            return snapshot;
        },
        async sendMessage(message) {
            attempts.push(message);
            if (attempts.length === 1) {
                throw new Error('Telegram unavailable');
            }
        },
        now: () => now,
        logger: {error: (error) => errors.push(error)},
        allowsAlerts(timestamp, direction) {
            assert.equal(timestamp, now);
            assert.equal(direction, undefined);
            return allowed;
        }
    });

    await poll();
    assert.equal(loads, 0);
    allowed = true;
    await poll();
    assert.deepEqual(attempts, []);

    snapshot.stale = false;
    await poll();
    await poll();
    await poll();
    const message = 'U1 service notice · U1: Verspätungen\nUnregelmäßige Intervalle.';
    assert.deepEqual(attempts, [message, message]);
    assert.deepEqual(errors, ['Telegram U1 alert failed']);
});

function departure(id, minutesAway, delay = 0, cancelled = false) {
    const plannedAt = now + minutesAway * 60_000;
    return {
        pr: 'REX 1',
        delay,
        cancelled,
        [departureTiming]: {
            tripId: id,
            plannedAt,
            expectedAt: cancelled ? plannedAt : plannedAt + delay * 1000
        }
    };
}

test('poll checks all upcoming trains in both directions and skips stale data', async () => {
    const messages = [];
    const data = {
        badVoeslauToWien: [
            departure('past', -12, 300),
            departure('past-cancellation', -4, 0, true),
            departure('next', 3, 299),
            departure('later', 24, 600),
            departure('cancelled-near-end-of-window', 115, 0, true)
        ],
        wienToBadVoeslau: [
            departure('delayed-past-planned-time', -2, 300),
            departure('southbound', 9, 300)
        ]
    };
    const snapshot = {data, stale: true};
    const poll = createTelegramPoll({
        getDepartures: async () => snapshot,
        sendMessage: async (message) => messages.push(message),
        now: () => now,
        logger: console
    });

    await poll();
    assert.deepEqual(messages, []);

    snapshot.stale = false;
    await poll();
    await poll();
    assert.deepEqual(messages, [
        'Bad Vöslau → Wien Hbf · REX 1 10:24 · delayed 10 min',
        'Bad Vöslau → Wien Hbf · REX 1 11:55 · cancelled',
        'Wien Hbf → Bad Vöslau · REX 1 09:58 · delayed 5 min',
        'Wien Hbf → Bad Vöslau · REX 1 10:09 · delayed 5 min'
    ]);
});

test('delay increases cross five-minute marks and decreases require a five-minute drop', async () => {
    const messages = [];
    const data = {badVoeslauToWien: [], wienToBadVoeslau: []};
    const poll = createTelegramPoll({
        getDepartures: async () => ({data, stale: false}),
        sendMessage: async (message) => messages.push(message),
        now: () => now,
        logger: console
    });

    async function reportDelay(seconds) {
        data.badVoeslauToWien = [departure('northbound', 6, seconds)];
        await poll();
    }

    await reportDelay(299);
    assert.equal(messages.length, 0);
    await reportDelay(300);
    await reportDelay(540);
    assert.equal(messages.length, 1);
    await reportDelay(600);
    await reportDelay(540);
    await reportDelay(600);
    await reportDelay(301);
    assert.equal(messages.length, 2);
    await reportDelay(300);
    await reportDelay(null);
    assert.equal(messages.length, 3);
    await reportDelay(0);
    await reportDelay(0);
    await reportDelay(1260);

    assert.deepEqual(messages, [
        'Bad Vöslau → Wien Hbf · REX 1 10:06 · delayed 5 min',
        'Bad Vöslau → Wien Hbf · REX 1 10:06 · delay increased to 10 min',
        'Bad Vöslau → Wien Hbf · REX 1 10:06 · delay decreased to 5 min',
        'Bad Vöslau → Wien Hbf · REX 1 10:06 · back on time',
        'Bad Vöslau → Wien Hbf · REX 1 10:06 · delay increased to 21 min'
    ]);
});

test('a failed send can be retried and a cancellation can follow delay updates', async () => {
    const messages = [];
    const errors = [];
    let failSend = true;
    const data = {
        badVoeslauToWien: [departure('northbound', 6, 360)],
        wienToBadVoeslau: []
    };
    const poll = createTelegramPoll({
        getDepartures: async () => ({data, stale: false}),
        async sendMessage(message) {
            if (failSend) {
                throw new Error('simulated network failure');
            }
            messages.push(message);
        },
        now: () => now,
        logger: {error: (message) => errors.push(message)}
    });

    await poll();
    assert.deepEqual(messages, []);
    assert.deepEqual(errors, ['Telegram train alert failed']);

    failSend = false;
    await poll();
    failSend = true;
    data.badVoeslauToWien = [departure('northbound', 6, 720)];
    await poll();
    assert.equal(messages.length, 1);
    failSend = false;
    await poll();

    data.badVoeslauToWien = [departure('northbound', 6, 0, true)];
    await poll();
    await poll();
    assert.deepEqual(messages, [
        'Bad Vöslau → Wien Hbf · REX 1 10:06 · delayed 6 min',
        'Bad Vöslau → Wien Hbf · REX 1 10:06 · delay increased to 12 min',
        'Bad Vöslau → Wien Hbf · REX 1 10:06 · cancelled'
    ]);
});

test('Telegram sender requires positive confirmation from the Bot API', async () => {
    let result = {ok: false};
    const send = createTelegramSender({
        botToken: '123:mock-token',
        chatId: '-456'
    }, async (url, options) => {
        assert.equal(url, 'https://api.telegram.org/bot123:mock-token/sendMessage');
        assert.equal(options.method, 'POST');
        assert.deepEqual(JSON.parse(options.body), {chat_id: '-456', text: 'Delay alert'});
        return new Response(JSON.stringify(result));
    });

    await assert.rejects(send('Delay alert'), /Telegram rejected/);
    result = {ok: true};
    await send('Delay alert');
});


test('poll honors schedule changes during a refresh and keeps alert history', async () => {
    let allowed = true;
    let changeDuringRefresh = true;
    const messages = [];
    const poll = createTelegramPoll({
        async getDepartures() {
            if (changeDuringRefresh) {
                allowed = false;
            }
            return {data: {
                badVoeslauToWien: [departure('delayed', 10, 300)],
                wienToBadVoeslau: []
            }, stale: false};
        },
        allowsAlerts: () => allowed,
        sendMessage: async (message) => messages.push(message),
        now: () => now,
        logger: console
    });

    await poll();
    assert.equal(messages.length, 0);
    changeDuringRefresh = false;
    allowed = true;
    await poll();
    assert.equal(messages.length, 1);
    allowed = false;
    await poll();
    allowed = true;
    await poll();
    assert.equal(messages.length, 1);
});
