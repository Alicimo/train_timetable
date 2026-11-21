const {departureTiming} = require('./fetch_departures');

const POLL_INTERVAL_MS = 60_000;
const SEND_TIMEOUT_MS = 10_000;
const ALERT_MEMORY_MS = 2 * 60 * 60 * 1_000;
const MIN_DELAY_SECONDS = 5 * 60;

const directions = {
    badVoeslauToWien: 'Bad Vöslau → Wien Hbf',
    wienToBadVoeslau: 'Wien Hbf → Bad Vöslau'
};

const departureClock = new Intl.DateTimeFormat('de-AT', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Vienna'
});

function nextDeparture(trains, now) {
    let next;
    let nextAt = Infinity;

    for (const train of trains) {
        const timing = train[departureTiming];
        const departureAt = train.cancelled ? timing?.plannedAt : timing?.expectedAt;
        if (departureAt >= now && departureAt < nextAt) {
            next = train;
            nextAt = departureAt;
        }
    }

    return next;
}

function createTelegramPoll({getDepartures, sendMessage, now, logger}) {
    const sentAlerts = new Map();

    return async function poll(signal) {
        const {data, stale} = await getDepartures();
        if (stale || signal?.aborted) {
            return;
        }

        const checkedAt = now();
        for (const [key, alert] of sentAlerts) {
            if (alert.expiresAt <= checkedAt) {
                sentAlerts.delete(key);
            }
        }

        for (const [direction, route] of Object.entries(directions)) {
            if (signal?.aborted) {
                return;
            }

            const train = nextDeparture(data[direction], checkedAt);
            const timing = train?.[departureTiming];
            if (!timing?.tripId || !Number.isFinite(timing.plannedAt)) {
                continue;
            }

            if (!train.cancelled && train.delay < MIN_DELAY_SECONDS) {
                continue;
            }

            const key = JSON.stringify([direction, timing.tripId, timing.plannedAt]);
            const previous = sentAlerts.get(key);
            if (previous && (previous.cancelled || !train.cancelled)) {
                continue;
            }

            const disruption = train.cancelled
                ? 'cancelled'
                : `delayed ${Math.floor(train.delay / 60)} min`;
            const text = `${route} · ${train.pr} ${departureClock.format(timing.plannedAt)} · ${disruption}`;
            try {
                await sendMessage(text);
                sentAlerts.set(key, {
                    cancelled: train.cancelled,
                    expiresAt: Math.max(timing.plannedAt, timing.expectedAt) + ALERT_MEMORY_MS
                });
            } catch {
                logger.error('Telegram train alert failed');
            }
        }
    };
}

function startTelegramAlerts(options) {
    const poll = createTelegramPoll(options);
    const controller = new AbortController();
    let timer;

    async function tick() {
        try {
            await poll(controller.signal);
        } catch {
            options.logger.error('Could not check departures for Telegram alerts');
        }

        if (!controller.signal.aborted) {
            timer = setTimeout(tick, POLL_INTERVAL_MS);
            timer.unref();
        }
    }

    void tick();
    return () => {
        controller.abort();
        clearTimeout(timer);
    };
}

function telegramSenderFromEnv(env, request = fetch) {
    const token = env.TELEGRAM_BOT_TOKEN?.trim();
    const chatId = env.TELEGRAM_CHAT_ID?.trim();
    if (!token && !chatId) {
        return undefined;
    }
    if (!token || !chatId) {
        throw new Error('Set both TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID to enable alerts');
    }
    if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) {
        throw new Error('Invalid TELEGRAM_BOT_TOKEN format');
    }

    return async function sendMessage(text) {
        const response = await request(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({chat_id: chatId, text}),
            redirect: 'error',
            signal: AbortSignal.timeout(SEND_TIMEOUT_MS)
        });
        const result = await response.json();
        if (!response.ok || result?.ok !== true) {
            throw new Error('Telegram rejected the train alert');
        }
    };
}

module.exports = {createTelegramPoll, startTelegramAlerts, telegramSenderFromEnv};
