const {randomUUID} = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const {createTelegramSender} = require('./telegram_alerts');

const TEST_MESSAGE = 'Train updates · Telegram alerts test';
const DISABLED_MESSAGE = 'Train updates · Telegram alerts have been disabled.';

class TelegramSettingsError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
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
    let settings = {enabled: false, chatId: null, botToken: null};
    let issue;

    try {
        const saved = JSON.parse(await fs.readFile(file, 'utf8'));
        if (!saved || typeof saved.enabled !== 'boolean'
            || (!validCredentials(saved) && !(saved.enabled === false
                && saved.chatId === null && saved.botToken === null))) {
            throw new Error('Invalid saved settings');
        }
        settings = saved;
    } catch (error) {
        if (error.code !== 'ENOENT') {
            issue = 'Could not read saved Telegram settings. Enter the chat ID and token to replace them.';
        } else {
            const botToken = env.TELEGRAM_BOT_TOKEN?.trim();
            const chatId = env.TELEGRAM_CHAT_ID?.trim();
            if (botToken || chatId) {
                const seed = {enabled: true, chatId, botToken};
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
        if (!input || typeof input.enabled !== 'boolean'
            || (input.enabled && (typeof input.chatId !== 'string'
                || (input.botToken !== undefined && typeof input.botToken !== 'string')))) {
            throw new TelegramSettingsError(400, 'Enter a valid Telegram chat ID and bot token.');
        }

        let next = {...settings, enabled: false};
        if (input.enabled) {
            next = {
                enabled: true,
                chatId: input.chatId.trim(),
                botToken: input.botToken?.trim() || settings.botToken
            };
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
            ...(issue ? {issue} : {})
        };
    }

    return {
        status,
        sender: () => settings.enabled ? createTelegramSender(settings, request) : undefined,
        update(input, applySender) {
            const result = pendingUpdate.then(() => update(input, applySender));
            pendingUpdate = result.catch(() => {});
            return result;
        }
    };
}

module.exports = {createTelegramSettings, TelegramSettingsError};
