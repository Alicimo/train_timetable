#!/usr/bin/env node

const {createClient} = require('hafas-client');
const {profile} = require('hafas-client/p/oebb/index.js');

const abortableProfile = {
    ...profile,
    transformReq(ctx, req) {
        const transformedRequest = profile.transformReq
            ? profile.transformReq(ctx, req)
            : req;
        return ctx.opt.signal
            ? {...transformedRequest, signal: ctx.opt.signal}
            : transformedRequest;
    }
};

const hafas = createClient(
    abortableProfile,
    process.env.HAFAS_USER_AGENT || 'train-updates'
);

const JOURNEY_WINDOW_MS = 2 * 60 * 60_000;
const DEPARTURE_LOOKBACK_MS = 30 * 60_000;
const departureTiming = Symbol('departureTiming');

const badVoeslau = {id: '8100708', name: 'Bad Vöslau Bahnhof'};
const wienHbf = {id: '8103000', name: 'Wien Hbf'};
const wienHbfPlatformsOneAndTwo = '8101590';
const railProducts = {bus: false, subway: false, tram: false, ferry: false, onCall: false};

const departureClock = new Intl.DateTimeFormat('de-AT', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Vienna'
});

function matchesStation(stop, station) {
    return stop?.id === station.id || (
        station === wienHbf && stop?.id === wienHbfPlatformsOneAndTwo
    );
}

function toDeparture(leg, plannedAt, expectedAt) {
    const delay = Number.isFinite(leg.departureDelay) ? leg.departureDelay : null;
    const cancelled = leg.cancelled === true;
    const direction = leg.direction || '';
    const train = {
        ti: departureClock.format(plannedAt),
        st: direction || leg.destination?.name || 'Unknown',
        pr: leg.line.name || 'Unknown',
        tr: leg.departurePlatform || '',
        rt: delay > 0 && !cancelled ? {dlt: departureClock.format(expectedAt)} : undefined,
        direction,
        delay,
        cancelled
    };

    Object.defineProperty(train, departureTiming, {
        value: {tripId: leg.tripId, plannedAt, expectedAt}
    });
    return train;
}

async function fetchDirection(client, from, to, start, signal) {
    const end = start + JOURNEY_WINDOW_MS;
    const departures = new Map();
    const seenCursors = new Set();
    // HAFAS may page by scheduled time, even when a delayed train has yet to depart.
    let page = {departure: new Date(start - DEPARTURE_LOOKBACK_MS)};

    while (true) {
        signal?.throwIfAborted();
        const {journeys = [], laterRef} = await client.journeys(from.id, to.id, {
            ...page,
            transfers: 0,
            results: 15,
            products: railProducts,
            signal
        });

        let reachedEnd = false;
        for (const {legs} of journeys) {
            const [leg] = legs;
            const plannedAt = Date.parse(leg?.plannedDeparture);
            if (plannedAt >= end) {
                reachedEnd = true;
            }
            if (legs.length !== 1 || leg.line?.mode !== 'train'
                || !matchesStation(leg.origin, from) || !matchesStation(leg.destination, to)
                || !Number.isFinite(plannedAt) || plannedAt >= end) {
                continue;
            }

            const expectedAt = Date.parse(leg.departure ?? leg.plannedDeparture);
            const departureAt = leg.cancelled ? plannedAt : expectedAt;
            if (departureAt >= start) {
                const key = JSON.stringify([leg.tripId ?? leg.line.name, plannedAt]);
                departures.set(key, toDeparture(leg, plannedAt, expectedAt));
            }
        }

        if (reachedEnd || !laterRef) {
            break;
        }
        if (seenCursors.has(laterRef)) {
            throw new Error('HAFAS repeated a journey pagination cursor');
        }
        seenCursors.add(laterRef);
        page = {laterThan: laterRef};
    }

    return [...departures.values()].sort((a, b) =>
        a[departureTiming].plannedAt - b[departureTiming].plannedAt
    );
}

function createDepartureFetcher(hafasClient, now = Date.now) {
    return async function fetchDepartures({signal} = {}) {
        const start = now();
        const [badVoeslauToWien, wienToBadVoeslau] = await Promise.all([
            fetchDirection(hafasClient, badVoeslau, wienHbf, start, signal),
            fetchDirection(hafasClient, wienHbf, badVoeslau, start, signal)
        ]);

        return {
            badVoeslauToWien,
            wienToBadVoeslau,
            lastUpdated: new Date(now()).toISOString(),
            stations: {badVoeslau: {...badVoeslau}, wienHbf: {...wienHbf}}
        };
    };
}

const fetchDepartures = createDepartureFetcher(hafas);

if (require.main === module) {
    fetchDepartures()
        .then((departures) => console.log(JSON.stringify(departures, null, 2)))
        .catch((error) => {
            console.error('❌ Error fetching journeys:', error.message);
            process.exitCode = 1;
        });
}

module.exports = {createDepartureFetcher, departureTiming, fetchDepartures};
