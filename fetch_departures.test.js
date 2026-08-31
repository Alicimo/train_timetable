const assert = require('node:assert/strict');
const test = require('node:test');

const {createDepartureFetcher} = require('./fetch_departures');

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
    assert.equal(result.wienToBadVoeslau.length, 1);
    assert.equal(result.wienToBadVoeslau[0].pr, 'REX 1');
});
