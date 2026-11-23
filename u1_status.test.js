const assert = require('node:assert/strict');
const test = require('node:test');

const {fetchU1Status} = require('./u1_status');

const now = () => Date.parse('2026-11-23T06:21:56+01:00');

// Shapes from the Wiener Linien tram 25 delay and tram 1 track-works notices.
const delay = {
    name: 'I20261123-0003',
    refTrafficInfoCategoryId: 2,
    relatedLines: ['U1'],
    relatedStops: null,
    status: 'active',
    title: 'Verspätungen',
    description: 'Unregelmäßige Intervalle in beiden Richtungen. Grund: Schadhaftes Fahrzeug.',
    time: {start: '2026-11-23T06:06:00.000+0100', resume: '2026-11-23T06:06:00.000+0100'}
};
const closure = {
    name: 'R1875-101',
    refTrafficInfoCategoryId: 3,
    title: 'Gleisbauarbeiten\nKein Betrieb',
    description: 'Gleisbauarbeiten\nKein Betrieb',
    relatedLines: ['U1'],
    relatedStops: [1875],
    time: {start: '2026-11-23T00:00:10.000+0100', end: '2026-11-23T23:59:59.000+0100'}
};
const categories = [
    {id: 2, name: 'stoerunglang'}, {id: 3, name: 'stoerungkurz'}, {id: 1, name: 'aufzugsinfo'}
];

test('U1 status reads detailed and stop notices with active service information', async () => {
    const signal = new AbortController().signal;
    const status = await fetchU1Status({now, signal, request: async (url, options) => {
        const query = new URL(url).searchParams;
        assert.equal(query.get('relatedLine'), 'U1');
        assert.deepEqual(query.getAll('name'), ['stoerunglang', 'stoerungkurz']);
        assert.equal(options.signal, signal);
        return Response.json({
            message: {messageCode: 1},
            data: {trafficInfoCategories: categories, trafficInfos: [
                delay, closure, {...closure, name: 'R1876-101', relatedStops: [1876]},
                {...delay, name: 'resolved', status: 'resolved'},
                {...delay, name: 'future', time: {start: '2026-11-24T06:00:00.000+0100'}},
                {...closure, name: 'ended', time: {end: '2026-11-23T06:21:56.000+0100'}},
                {...delay, name: 'lift', refTrafficInfoCategoryId: 1},
                {...delay, name: 'tram', relatedLines: ['26E'], description: 'Bitte die U1 nutzen.'}
            ]}
        });
    }});

    const shortNotice = {
        id: closure.name, detailed: false, title: closure.title, description: closure.description,
        startsAt: '2026-11-22T23:00:10.000Z', endsAt: '2026-11-23T22:59:59.000Z'
    };
    assert.deepEqual(status, {
        checkedAt: '2026-11-23T05:21:56.000Z',
        notices: [
            {id: delay.name, detailed: true, title: delay.title, description: delay.description,
                startsAt: '2026-11-23T05:06:00.000Z', endsAt: null},
            shortNotice,
            {...shortNotice, id: 'R1876-101'}
        ]
    });
});

test('U1 status distinguishes an empty feed from an upstream failure', async () => {
    const get = (response) => fetchU1Status({now, request: async () => response});
    assert.deepEqual(await get(Response.json({data: {trafficInfos: []}, message: {messageCode: 1}})), {
        checkedAt: '2026-11-23T05:21:56.000Z', notices: []
    });
    await assert.rejects(get(Response.json({data: {}, message: {messageCode: 1}})), /Invalid Wiener Linien/);
    await assert.rejects(get(Response.json({data: {trafficInfos: []}, message: {messageCode: 2}})), /Invalid Wiener Linien/);
    await assert.rejects(get(new Response(null, {status: 503})), /HTTP 503/);
});
