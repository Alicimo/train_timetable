const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const {tmpdir} = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {createDelayHistoryPoll} = require('./delay_history');
const {departureTiming} = require('./fetch_departures');

const observedAt = '2026-11-23T22:58:30.000Z';

function train(scheduledDeparture, {tripId = null, trainNumber, delay = null, cancelled = false} = {}) {
    return {
        pr: 'REX 1', delay, cancelled,
        [departureTiming]: {tripId, trainNumber, plannedAt: Date.parse(scheduledDeparture)}
    };
}

async function tempDirectory(t) {
    const directory = await fs.mkdtemp(path.join(tmpdir(), 'train-delay-history-'));
    t.after(() => fs.rm(directory, {recursive: true, force: true}));
    return directory;
}

async function readRows(file) {
    return (await fs.readFile(file, 'utf8')).trimEnd().split('\n').map((line) => JSON.parse(line));
}

test('records one observation per run and partitions by Vienna departure date', async (t) => {
    const directory = await tempDirectory(t);
    const onTime = train('2026-11-23T22:59:00Z', {tripId: 'outbound', trainNumber: 2307, delay: 0});
    const unknown = train('2026-11-23T22:59:00Z', {tripId: 'outbound', trainNumber: '2308'});
    const cancelled = train('2026-11-23T23:00:30Z', {trainNumber: '2309', cancelled: true});
    const unnumbered = train('2026-11-23T23:00:30Z', {delay: 90});
    const data = {
        lastUpdated: observedAt,
        badVoeslauToWien: [
            onTime,
            train('2026-11-23T22:58:29Z'),
            train('2026-11-23T23:00:31Z'),
            {pr: 'Unknown timing'}
        ],
        wienToBadVoeslau: [unknown, cancelled, unnumbered]
    };
    let stale = true;
    const options = {directory, getDepartures: async () => ({data, stale})};
    const poll = createDelayHistoryPoll(options);

    await poll();
    assert.deepEqual(await fs.readdir(directory), []);

    stale = false;
    await poll();
    onTime.delay = 300;
    await poll();

    const today = path.join(directory, '2026-11-23.jsonl');
    const tomorrow = path.join(directory, '2026-11-24.jsonl');
    await fs.appendFile(tomorrow, '{"observedAt":');
    await createDelayHistoryPoll(options)();

    assert.deepEqual(await readRows(today), [
        {
            observedAt, scheduledDeparture: '2026-11-23T22:59:00.000Z',
            direction: 'badVoeslauToWien', tripId: 'outbound', trainNumber: '2307',
            serviceName: 'REX 1', delaySeconds: 0, cancelled: false
        },
        {
            observedAt, scheduledDeparture: '2026-11-23T22:59:00.000Z',
            direction: 'wienToBadVoeslau', tripId: 'outbound', trainNumber: '2308',
            serviceName: 'REX 1', delaySeconds: null, cancelled: false
        }
    ]);
    assert.deepEqual(await readRows(tomorrow), [
        {
            observedAt, scheduledDeparture: '2026-11-23T23:00:30.000Z',
            direction: 'wienToBadVoeslau', tripId: null, trainNumber: '2309',
            serviceName: 'REX 1', delaySeconds: null, cancelled: true
        },
        {
            observedAt, scheduledDeparture: '2026-11-23T23:00:30.000Z',
            direction: 'wienToBadVoeslau', tripId: null, trainNumber: null,
            serviceName: 'REX 1', delaySeconds: 90, cancelled: false
        }
    ]);
});

test('retries a run after the history file can be written again', async (t) => {
    const directory = await tempDirectory(t);
    const data = {
        lastUpdated: observedAt,
        badVoeslauToWien: [train('2026-11-23T23:00:00Z', {tripId: 'first'})],
        wienToBadVoeslau: []
    };
    const poll = createDelayHistoryPoll({directory, getDepartures: async () => ({data, stale: false})});
    const file = path.join(directory, '2026-11-24.jsonl');
    await poll();

    const backup = file + '.backup';
    await fs.rename(file, backup);
    await fs.mkdir(file);
    data.badVoeslauToWien.push(train('2026-11-23T23:00:15Z', {tripId: 'second'}));
    await assert.rejects(poll(), {code: 'EISDIR'});

    await fs.rmdir(file);
    await fs.rename(backup, file);
    await poll();
    assert.deepEqual((await readRows(file)).map((row) => row.tripId), ['first', 'second']);
});
