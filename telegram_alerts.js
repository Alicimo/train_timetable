const {departureTiming} = require('./fetch_departures');

const POLL_INTERVAL_MS = 60_000;
const SEND_TIMEOUT_MS = 10_000;
const ALERT_MEMORY_MS = 2 * 60 * 60 * 1_000;
const DELAY_STEP_SECONDS = 5 * 60;

const directions = {
    badVoeslauToWien: 'Bad Vöslau → Wien Hbf',
    wienToBadVoeslau: 'Wien Hbf → Bad Vöslau'
};

const departureClock = new Intl.DateTimeFormat('de-AT', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Vienna'
});

function createTelegramPoll({getDepartures, sendMessage, now, logger, allowsAlerts = () => true}) {
    const sentAlerts = new Map();

    return async function poll(signal) {
        if (!allowsAlerts(now())) {
            return;
        }
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
            for (const train of data[direction]) {
                if (signal?.aborted) {
                    return;
                }

                const timing = train[departureTiming];
                const departureAt = train.cancelled ? timing?.plannedAt : timing?.expectedAt;
                if (!timing?.tripId || !Number.isFinite(timing.plannedAt)
                    || !Number.isFinite(departureAt) || departureAt < checkedAt) {
                    continue;
                }

                const key = JSON.stringify([direction, timing.tripId, timing.plannedAt]);
                const previous = sentAlerts.get(key);
                if (previous?.cancelled || (!train.cancelled && !Number.isFinite(train.delay))) {
                    continue;
                }

                const delay = train.cancelled ? 0 : Math.max(0, train.delay);
                let disruption = 'cancelled';
                if (!train.cancelled) {
                    const delayBand = Math.floor(delay / DELAY_STEP_SECONDS);
                    const previousDelay = previous?.delay ?? 0;
                    const previousBand = Math.floor(previousDelay / DELAY_STEP_SECONDS);
                    const increased = delayBand > previousBand;
                    const decreased = previousDelay - delay >= DELAY_STEP_SECONDS;
                    if (!increased && !decreased) {
                        continue;
                    }

                    const minutes = Math.floor(delay / 60);
                    if (!previous) {
                        disruption = `delayed ${minutes} min`;
                    } else if (delay === 0) {
                        disruption = 'back on time';
                    } else {
                        const duration = minutes ? `${minutes} min` : 'under 1 min';
                        disruption = increased ? `delay increased to ${duration}` : `delay decreased to ${duration}`;
                    }
                }
                const text = `${route} · ${train.pr} ${departureClock.format(timing.plannedAt)} · ${disruption}`;
                if (!allowsAlerts(now(), direction)) {
                    break;
                }
                try {
                    await sendMessage(text, signal);
                    sentAlerts.set(key, {
                        cancelled: train.cancelled,
                        delay,
                        expiresAt: Math.max(timing.plannedAt, timing.expectedAt) + ALERT_MEMORY_MS
                    });
                } catch {
                    if (!signal?.aborted) {
                        logger.error('Telegram train alert failed');
                    }
                }
            }
        }
    };
}

function createU1TelegramPoll({getU1Status, sendMessage, now, logger, allowsAlerts = () => true}) {
    const sent = new Set();

    return async function poll(signal) {
        if (signal?.aborted || !allowsAlerts(now())) {
            return;
        }
        const {data, stale} = await getU1Status();
        if (stale) {
            return;
        }

        for (const {id, detailed, title, description, endsAt} of data.notices) {
            if (signal?.aborted || !allowsAlerts(now())) {
                return;
            }
            if (!detailed || sent.has(id) || (endsAt && Date.parse(endsAt) <= now())) {
                continue;
            }

            const body = description && description !== title ? `\n${description}` : '';
            const text = `U1 service notice · ${title}${body}`;
            try {
                await sendMessage(text, signal);
                sent.add(id);
            } catch {
                if (!signal?.aborted) {
                    logger.error('Telegram U1 alert failed');
                }
            }
        }
    };
}

function startPolling(poll, onError) {
    const controller = new AbortController();
    let timer;

    async function tick() {
        try {
            await poll(controller.signal);
        } catch {
            if (!controller.signal.aborted) {
                onError();
            }
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

function startTelegramAlerts(options) {
    const stopTrains = startPolling(createTelegramPoll(options),
        () => options.logger.error('Could not check departures for Telegram alerts'));
    const stopU1 = options.getU1Status && startPolling(createU1TelegramPoll(options),
        () => options.logger.error('Could not check U1 status for Telegram alerts'));

    return () => {
        stopTrains();
        stopU1?.();
    };
}

function createTelegramSender({botToken, chatId}, request = fetch) {
    return async function sendMessage(text, signal) {
        const timeout = AbortSignal.timeout(SEND_TIMEOUT_MS);
        const response = await request(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({chat_id: chatId, text}),
            redirect: 'error',
            signal: signal ? AbortSignal.any([signal, timeout]) : timeout
        });
        const result = await response.json();
        if (!response.ok || result?.ok !== true) {
            throw new Error('Telegram rejected the message');
        }
    };
}

module.exports = {createTelegramPoll, createU1TelegramPoll, startTelegramAlerts, createTelegramSender, directions};
