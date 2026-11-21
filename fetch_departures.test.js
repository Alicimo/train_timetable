const assert = require('node:assert/strict');
const test = require('node:test');

const {createDepartureFetcher, departureTiming} = require('./fetch_departures');

test('departure fetcher preserves the API contract and route filters', async () => {
    const client = {
        async locations(query, options) {
            assert.ok(options.signal);
            return query === 'Bad Vöslau'
                ? [{name: 'Bad Vöslau', id: 'bad'}]
                : [{name: 'Wien Hbf', id: 'wien'}];
        },
        async departures(stationId, options) {
            assert.ok(options.signal);
            if (stationId === 'bad') {
                return {
                    departures: [
                        {
                            tripId: 'train-1',
                            plannedWhen: '2026-08-31T09:58:00+02:00',
                            when: '2026-08-31T10:00:00+02:00',
                            destination: {name: 'Wien Hbf'},
                            direction: 'Wien Hbf',
                            line: {name: 'REX 1', mode: 'train'},
                            platform: '2',
                            delay: 120
                        },
                        {
                            when: '2026-08-31T10:05:00+02:00',
                            destination: {name: 'Wien'},
                            direction: 'Wien',
                            line: {name: 'Bus 1', mode: 'bus'}
                        }
                    ]
                };
            }

            return {
                departures: [
                    {
                        when: '2026-08-31T11:00:00+02:00',
                        destination: {name: 'Wr.Neustadt Hbf'},
                        direction: 'Wr.Neustadt Hbf',
                        line: {name: 'REX 1', mode: 'train'},
                        platform: '4'
                    },
                    {
                        when: '2026-08-31T11:05:00+02:00',
                        destination: {name: 'Wr.Neustadt Hbf'},
                        direction: 'Wr.Neustadt Hbf',
                        line: {name: 'S 4', mode: 'train'}
                    },
                    {
                        tripId: 'cancelled-train',
                        plannedWhen: '2026-08-31T11:08:00+02:00',
                        when: null,
                        cancelled: true,
                        destination: {name: 'Wr.Neustadt Hbf'},
                        line: {name: 'REX 3', mode: 'train'}
                    },
                    {
                        when: '2026-08-31T11:10:00+02:00',
                        destination: {name: 'Graz Hbf'},
                        direction: 'Graz Hbf',
                        line: {name: 'REX 1', mode: 'train'}
                    }
                ]
            };
        }
    };
    const fetchDepartures = createDepartureFetcher(client);
    const result = await fetchDepartures({signal: new AbortController().signal});

    assert.deepEqual(Object.keys(result), [
        'badVoeslauToWien',
        'wienToBadVoeslau',
        'lastUpdated',
        'stations'
    ]);
    assert.deepEqual(result.stations, {
        badVoeslau: {name: 'Bad Vöslau', id: 'bad'},
        wienHbf: {name: 'Wien Hbf', id: 'wien'}
    });
    assert.equal(result.badVoeslauToWien.length, 1);
    assert.deepEqual(result.badVoeslauToWien[0], {
        ti: '10:00',
        st: 'Wien Hbf',
        pr: 'REX 1',
        tr: '2',
        rt: {dlt: '10:02'},
        direction: 'Wien Hbf',
        delay: 120,
        cancelled: false
    });
    assert.deepEqual(result.badVoeslauToWien[0][departureTiming], {
        tripId: 'train-1',
        plannedAt: Date.parse('2026-08-31T09:58:00+02:00'),
        expectedAt: Date.parse('2026-08-31T10:00:00+02:00')
    });
    const publicRow = JSON.stringify(result.badVoeslauToWien[0]);
    assert.doesNotMatch(publicRow, /train-1|plannedAt|expectedAt/);
    assert.equal(result.wienToBadVoeslau.length, 2);
    assert.equal(result.wienToBadVoeslau[0].pr, 'REX 1');
    const cancelledTrain = result.wienToBadVoeslau[1];
    assert.equal(cancelledTrain.cancelled, true);
    assert.equal(cancelledTrain[departureTiming].plannedAt, Date.parse('2026-08-31T11:08:00+02:00'));
});
