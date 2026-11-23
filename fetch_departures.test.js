const assert = require('node:assert/strict');
const test = require('node:test');

const {createDepartureFetcher, departureTiming} = require('./fetch_departures');

const now = Date.parse('2026-08-31T10:00:00+02:00');
const bad = {id: '8100708', name: 'Bad Vöslau Bahnhof'};
const wien = {id: '8103000', name: 'Wien Hbf'};
const wienPlatformsOneAndTwo = {id: '8101590', name: 'Wien Hbf (Bahnsteige 1-2)'};
const time = (clock) => `2026-08-31T${clock}:00+02:00`;

function journey(clock, overrides = {}) {
    return {
        legs: [{
            tripId: clock,
            plannedDeparture: time(clock),
            departure: time(clock),
            origin: bad,
            destination: wien,
            line: {name: 'REX 1', mode: 'train'},
            ...overrides
        }]
    };
}

test('journey fetcher paginates the window and returns direct trains from both Vienna platform groups', async () => {
    const signal = new AbortController().signal;
    const calls = [];
    const delayed = journey('09:58', {
        destination: wienPlatformsOneAndTwo,
        line: {name: 'REX 1', mode: 'train', fahrtNr: '2307'},
        departure: time('10:03'),
        departureDelay: 300,
        plannedArrival: time('10:26'),
        arrival: time('10:28'),
        departurePlatform: '2',
        direction: 'Flughafen Wien'
    });
    const cancelled = journey('11:53', {
        departure: null,
        departureDelay: null,
        plannedArrival: time('12:20'),
        cancelled: true
    });
    const wienToBad = journey('10:08', {
        origin: wienPlatformsOneAndTwo,
        destination: bad,
        line: {name: 'S 80', mode: 'train'},
        direction: 'Wr.Neustadt Hbf',
        plannedArrival: time('10:36')
    });

    const client = {
        async journeys(from, to, options) {
            calls.push([from, to, options.laterThan]);
            assert.equal(options.signal, signal);
            assert.equal(options.transfers, 0);
            assert.deepEqual(options.products, {bus: false, subway: false, tram: false, ferry: false, onCall: false});
            if (!options.laterThan) {
                assert.equal(+options.departure, Date.parse(time('09:30')));
            } else {
                assert.ok(!('departure' in options));
            }

            if (from === wien.id) {
                return {journeys: [wienToBad]};
            }
            if (options.laterThan === 'page-2') {
                return {
                    journeys: [delayed, cancelled, journey('12:00')],
                    laterRef: 'unused'
                };
            }

            const trainWithTransfer = journey('10:16');
            trainWithTransfer.legs.push(journey('10:45').legs[0]);
            return {
                journeys: [
                    journey('09:50'),
                    delayed,
                    journey('10:05', {destination: {id: 'wien-other', name: 'Other station'}}),
                    journey('10:10', {line: {name: 'Bus', mode: 'bus'}}),
                    trainWithTransfer,
                    journey('10:50', {departureDelay: 0})
                ],
                laterRef: 'page-2'
            };
        }
    };

    const fetchDepartures = createDepartureFetcher(client, () => now);
    const result = await fetchDepartures({signal});
    assert.deepEqual(calls, [
        [bad.id, wien.id, undefined],
        [wien.id, bad.id, undefined],
        [bad.id, wien.id, 'page-2']
    ]);
    assert.deepEqual(Object.keys(result), [
        'badVoeslauToWien', 'wienToBadVoeslau', 'lastUpdated', 'stations'
    ]);
    assert.deepEqual(result.stations, {badVoeslau: bad, wienHbf: wien});
    assert.equal(result.lastUpdated, new Date(now).toISOString());
    assert.deepEqual(result.badVoeslauToWien.map(train => train.ti), ['09:58', '10:50', '11:53']);

    const [delayedTrain, onTimeTrain, cancelledTrain] = result.badVoeslauToWien;
    assert.deepEqual(delayedTrain, {
        ti: '09:58',
        arrival: '10:28',
        st: 'Flughafen Wien',
        pr: 'REX 1',
        tr: '2',
        rt: {dlt: '10:03'},
        direction: 'Flughafen Wien',
        delay: 300,
        cancelled: false
    });
    assert.deepEqual(delayedTrain[departureTiming], {
        tripId: '09:58',
        trainNumber: '2307',
        plannedAt: Date.parse(time('09:58')),
        expectedAt: Date.parse(time('10:03'))
    });
    assert.doesNotMatch(JSON.stringify(delayedTrain), /tripId|trainNumber|plannedAt|expectedAt/);
    assert.equal(onTimeTrain.delay, 0);
    assert.equal(onTimeTrain.arrival, null);
    assert.equal(cancelledTrain.cancelled, true);
    assert.equal(cancelledTrain.delay, null);
    assert.equal(cancelledTrain.arrival, null);
    assert.equal(cancelledTrain.rt, undefined);
    assert.equal(cancelledTrain[departureTiming].plannedAt, Date.parse(time('11:53')));
    assert.equal(result.wienToBadVoeslau[0].pr, 'S 80');
    assert.equal(result.wienToBadVoeslau[0].delay, null);
    assert.equal(result.wienToBadVoeslau[0].arrival, '10:36');
});

test('journey fetcher rejects a repeated pagination cursor', async () => {
    const client = {
        async journeys() {
            return {journeys: [], laterRef: 'repeated'};
        }
    };
    const fetchDepartures = createDepartureFetcher(client, () => now);
    await assert.rejects(fetchDepartures(), /repeated a journey pagination cursor/);
});
