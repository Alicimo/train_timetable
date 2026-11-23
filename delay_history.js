const fs = require('node:fs/promises');
const path = require('node:path');

const {departureTiming} = require('./fetch_departures');
const {directions} = require('./telegram_alerts');

const OBSERVATION_WINDOW_MS = 120_000;
const viennaDate = new Intl.DateTimeFormat('sv-SE', {timeZone: 'Europe/Vienna'});

function runKey({direction, scheduledDeparture, tripId, trainNumber, serviceName}) {
    const identity = tripId ? ['trip', tripId]
        : trainNumber ? ['number', trainNumber] : ['service', serviceName];
    return JSON.stringify([direction, scheduledDeparture, identity]);
}

async function readRunKeys(file) {
    const contents = await fs.readFile(file).catch((error) => {
        if (error.code !== 'ENOENT') {
            throw error;
        }
        return Buffer.alloc(0);
    });
    const completeLength = contents.lastIndexOf(10) + 1;
    if (completeLength < contents.length) {
        // An interrupted append can leave an incomplete final JSON line.
        await fs.truncate(file, completeLength);
    }
    const lines = contents.subarray(0, completeLength).toString('utf8').split('\n');
    lines.pop();
    return new Set(lines.map((line) => runKey(JSON.parse(line))));
}

function createDelayHistoryPoll({directory, getDepartures}) {
    let currentFile;
    let runKeys;

    return async function poll(signal) {
        const {data, stale} = await getDepartures();
        if (stale || signal?.aborted) {
            return;
        }

        const observedAt = Date.parse(data.lastUpdated);
        if (!Number.isFinite(observedAt)) {
            return;
        }

        for (const direction of Object.keys(directions)) {
            for (const train of data[direction]) {
                if (signal?.aborted) {
                    return;
                }
                const timing = train[departureTiming];
                const timeUntilDeparture = timing?.plannedAt - observedAt;
                if (!(timeUntilDeparture >= 0 && timeUntilDeparture <= OBSERVATION_WINDOW_MS)) {
                    continue;
                }

                const file = path.join(directory, viennaDate.format(timing.plannedAt) + '.jsonl');
                if (file !== currentFile) {
                    await fs.mkdir(directory, {recursive: true, mode: 0o700});
                    runKeys = await readRunKeys(file);
                    currentFile = file;
                }

                const row = {
                    observedAt: data.lastUpdated,
                    scheduledDeparture: new Date(timing.plannedAt).toISOString(),
                    direction,
                    tripId: timing.tripId || null,
                    trainNumber: timing.trainNumber == null ? null : String(timing.trainNumber),
                    serviceName: train.pr,
                    delaySeconds: Number.isFinite(train.delay) ? train.delay : null,
                    cancelled: train.cancelled === true
                };
                const key = runKey(row);
                if (!runKeys.has(key) && !signal?.aborted) {
                    try {
                        await fs.appendFile(file, JSON.stringify(row) + '\n', {mode: 0o600});
                        runKeys.add(key);
                    } catch (error) {
                        currentFile = undefined;
                        throw error;
                    }
                }
            }
        }
    };
}

module.exports = {createDelayHistoryPoll};
