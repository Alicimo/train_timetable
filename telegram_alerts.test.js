const assert = require('node:assert/strict');
const test = require('node:test');

const {departureTiming} = require('./fetch_departures');
const {createTelegramPoll, telegramSenderFromEnv} = require('./telegram_alerts');

const now = Date.parse('2026-08-31T08:00:00Z');

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

test('poll checks the next upcoming train in each direction and skips stale data', async () => {
    const messages = [];
    const data = {
        badVoeslauToWien: [
            departure('past', -12, 300),
            departure('later', 24, 600),
            departure('next', 3, 299)
        ],
        wienToBadVoeslau: [departure('southbound', 9, 300)]
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
    assert.deepEqual(messages, ['Wien Hbf → Bad Vöslau · REX 1 10:09 · delayed 5 min']);
});

test('a failed send can be retried and a cancellation can follow one delay alert', async () => {
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
    data.badVoeslauToWien = [departure('northbound', 6, 720)];
    await poll();

    data.badVoeslauToWien = [departure('northbound', 6, 0, true)];
    await poll();
    await poll();
    assert.deepEqual(messages, [
        'Bad Vöslau → Wien Hbf · REX 1 10:06 · delayed 6 min',
        'Bad Vöslau → Wien Hbf · REX 1 10:06 · cancelled'
    ]);
});

test('Telegram sender requires positive confirmation from the Bot API', async () => {
    assert.equal(telegramSenderFromEnv({}), undefined);
    assert.throws(() => telegramSenderFromEnv({TELEGRAM_CHAT_ID: '123'}), /Set both/);

    let result = {ok: false};
    const send = telegramSenderFromEnv({
        TELEGRAM_BOT_TOKEN: '123:mock-token',
        TELEGRAM_CHAT_ID: '-456'
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
