const {randomUUID} = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const {
    createTelegramSender, directions, DELAY_STEP_MINUTES, DEFAULT_MINIMUM_DELAY_MINUTES
} = require('./telegram_alerts');

const TEST_MESSAGE = 'Train updates · Telegram alerts test';
const DISABLED_MESSAGE = 'Train updates · Telegram alerts have been disabled.';
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DEFAULT_SCHEDULE = {days: [0, 1, 2, 3, 4, 5, 6], windows: []};
const VIENNA_CLOCK = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Vienna', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
});
const TIME_PATTERN = /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/;

function normalizeSchedule(schedule, {discardDirectionless = false} = {}) {
    if (!schedule || !Array.isArray(schedule.days) || !Array.isArray(schedule.windows)
        || schedule.days.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) {
        throw new TelegramSettingsError(400, 'Choose valid notification days and time windows.');
    }

    const savedWindows = discardDirectionless
        ? schedule.windows.filter((window) => window?.direction !== undefined)
        : schedule.windows;
    const windows = savedWindows.map((window) => {
        if (!window || typeof window.start !== 'string' || typeof window.end !== 'string'
            || !TIME_PATTERN.test(window.start) || !TIME_PATTERN.test(window.end)
            || window.start === window.end) {
            throw new TelegramSettingsError(400, 'Each time window needs a different start and end time.');
        }
        const {start, end, direction} = window;
        if (direction !== 'both' && (typeof direction !== 'string' || !Object.hasOwn(directions, direction))) {
            throw new TelegramSettingsError(400, 'Choose a valid direction for each time window.');
        }
        return {start, end, direction};
    });
    const days = [...new Set(schedule.days)].sort();
    return {days, windows};
}

function isWithinSchedule({days, windows}, timestamp, direction) {
    if (!days.length) {
        return false;
    }
    if (days.length === 7 && !windows.length) {
        return true;
    }

    const parts = Object.fromEntries(VIENNA_CLOCK.formatToParts(timestamp).map(({type, value}) => [type, value]));
    const day = WEEKDAYS.indexOf(parts.weekday);
    const today = days.includes(day);
    if (!windows.length) {
        return today;
    }

    const time = parts.hour + ':' + parts.minute;
    const yesterday = days.includes((day + 6) % 7);
    return windows.some(({start, end, direction: windowDirection}) => {
        if (direction && windowDirection !== 'both' && windowDirection !== direction) {
            return false;
        }
        return start < end
            ? today && time >= start && time < end
            : (today && time >= start) || (yesterday && time < end);
    });
}

class TelegramSettingsError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

function normalizeMinimumDelayMinutes(value) {
    if (!Number.isSafeInteger(value) || value < DELAY_STEP_MINUTES || value % DELAY_STEP_MINUTES !== 0) {
        throw new TelegramSettingsError(400, 'Choose a minimum train delay of at least 5 minutes in 5-minute steps.');
    }
    return value;
}

function validCredentials({botToken, chatId}) {
    return typeof botToken === 'string' && /^\d+:[A-Za-z0-9_-]+$/.test(botToken)
        && typeof chatId === 'string' && /^(?:-?\d+|@[A-Za-z0-9_]+)$/.test(chatId);
}

async function saveSettings(file, settings) {
    const directory = path.dirname(file);
    await fs.mkdir(directory, {recursive: true, mode: 0o700});
    const temporaryFile = path.join(directory, `.telegram-${randomUUID()}.tmp`);
    try {
        await fs.writeFile(temporaryFile, JSON.stringify(settings) + '\n', {mode: 0o600, flag: 'wx'});
        await fs.rename(temporaryFile, file);
    } finally {
        await fs.rm(temporaryFile, {force: true}).catch(() => {});
    }
}

async function createTelegramSettings({directory, env = process.env, request = fetch}) {
    const file = path.join(directory, 'telegram.json');
    let settings = {
        enabled: false, chatId: null, botToken: null,
        schedule: DEFAULT_SCHEDULE, minimumDelayMinutes: DEFAULT_MINIMUM_DELAY_MINUTES
    };
    let issue;

    try {
        const saved = JSON.parse(await fs.readFile(file, 'utf8'));
        if (!saved || typeof saved.enabled !== 'boolean'
            || (!validCredentials(saved) && !(saved.enabled === false
                && saved.chatId === null && saved.botToken === null))) {
            throw new Error('Invalid saved settings');
        }
        settings = {
            ...saved,
            schedule: saved.schedule === undefined
                ? DEFAULT_SCHEDULE
                : normalizeSchedule(saved.schedule, {discardDirectionless: true}),
            minimumDelayMinutes: saved.minimumDelayMinutes === undefined
                ? DEFAULT_MINIMUM_DELAY_MINUTES
                : normalizeMinimumDelayMinutes(saved.minimumDelayMinutes)
        };
    } catch (error) {
        if (error.code !== 'ENOENT') {
            issue = 'Could not read saved Telegram settings. Enter the chat ID and token to replace them.';
        } else {
            const botToken = env.TELEGRAM_BOT_TOKEN?.trim();
            const chatId = env.TELEGRAM_CHAT_ID?.trim();
            if (botToken || chatId) {
                const seed = {...settings, enabled: true, chatId, botToken};
                if (!validCredentials(seed)) {
                    issue = 'The initial Telegram settings are invalid. Enter a chat ID and token below.';
                } else {
                    try {
                        await saveSettings(file, seed);
                        settings = seed;
                    } catch {
                        issue = 'Could not save the initial Telegram settings. Check the state directory permissions.';
                    }
                }
            }
        }
    }

    let pendingUpdate = Promise.resolve();

    async function update(input, applySender) {
        const preferencesOnly = input?.enabled === undefined
            && (input?.schedule !== undefined || input?.minimumDelayMinutes !== undefined);
        if (!input || (!preferencesOnly && typeof input.enabled !== 'boolean')
            || (input.enabled && (typeof input.chatId !== 'string'
                || (input.botToken !== undefined && typeof input.botToken !== 'string')))) {
            throw new TelegramSettingsError(400, 'Enter a valid Telegram chat ID and bot token.');
        }

        const schedule = input.schedule === undefined ? settings.schedule : normalizeSchedule(input.schedule);
        const minimumDelayMinutes = input.minimumDelayMinutes === undefined
            ? settings.minimumDelayMinutes
            : normalizeMinimumDelayMinutes(input.minimumDelayMinutes);
        const next = {
            ...settings, schedule, minimumDelayMinutes, enabled: preferencesOnly ? settings.enabled : input.enabled
        };
        if (input.enabled) {
            next.chatId = input.chatId.trim();
            next.botToken = input.botToken?.trim() || settings.botToken;
            if (!validCredentials(next)) {
                throw new TelegramSettingsError(400, 'Enter a valid Telegram chat ID and bot token.');
            }
            try {
                await createTelegramSender(next, request)(TEST_MESSAGE);
            } catch {
                throw new TelegramSettingsError(502, 'Could not deliver the test message. Check the bot token, chat ID, and bot access to the chat.');
            }
        }

        try {
            await saveSettings(file, next);
        } catch {
            throw new TelegramSettingsError(500, 'Could not save Telegram settings. Check the state directory permissions.');
        }

        const justDisabled = settings.enabled && !next.enabled;
        const senderChanged = settings.enabled !== next.enabled
            || settings.botToken !== next.botToken || settings.chatId !== next.chatId;
        settings = next;
        issue = undefined;
        if (senderChanged) {
            applySender(next.enabled ? createTelegramSender(next, request) : undefined);
        }
        if (justDisabled) {
            try {
                await createTelegramSender(next, request)(DISABLED_MESSAGE);
            } catch {
                return {...status(), warning: 'Alerts are disabled, but Telegram could not deliver the confirmation.'};
            }
        }
        return status();
    }

    function status() {
        return {
            enabled: settings.enabled,
            chatId: settings.chatId,
            hasToken: Boolean(settings.botToken),
            schedule: settings.schedule,
            minimumDelayMinutes: settings.minimumDelayMinutes,
            ...(issue ? {issue} : {})
        };
    }

    return {
        status,
        allowsAlerts: (timestamp, direction) => isWithinSchedule(settings.schedule, timestamp, direction),
        getMinimumDelayMinutes: () => settings.minimumDelayMinutes,
        sender: () => settings.enabled ? createTelegramSender(settings, request) : undefined,
        update(input, applySender) {
            const result = pendingUpdate.then(() => update(input, applySender));
            pendingUpdate = result.catch(() => {});
            return result;
        }
    };
}

module.exports = {createTelegramSettings, TelegramSettingsError};
