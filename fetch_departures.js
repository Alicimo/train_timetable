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

// Configuration constants
const DEPARTURE_DURATION_HOURS = 2;
const WIEN_DEPARTURE_DURATION_HOURS = 2;
const MAX_RESULTS_BAD_VOESLAU = 20;
const MAX_RESULTS_WIEN = 100;

async function fetchBadVoeslauDepartures(hafasClient, signal) {
    console.log('🔍 Searching for Bad Vöslau station...');

    // Search for Bad Vöslau station
    const stations = await hafasClient.locations('Bad Vöslau', {results: 5, signal});

    if (!stations || stations.length === 0) {
        throw new Error('No stations found for "Bad Vöslau"');
    }

    // Find the main Bad Vöslau station
    const badVoeslauStation = stations.find(station =>
        station.name && station.name.toLowerCase().includes('bad vöslau')
    ) || stations[0];

    console.log(`📍 Found Bad Vöslau station: ${badVoeslauStation.name} (ID: ${badVoeslauStation.id})`);

    console.log('🚂 Fetching departures from Bad Vöslau...');

    // Get departures for the next few hours
    const departures = await hafasClient.departures(badVoeslauStation.id, {
        duration: DEPARTURE_DURATION_HOURS * 60, // Convert hours to minutes
        results: MAX_RESULTS_BAD_VOESLAU,
        signal
    });

    // Handle different response formats
    const departuresList = departures.departures || departures || [];
    console.log(`📋 Found ${departuresList.length} total departures from Bad Vöslau`);

    // Filter trains that go to Wien Hauptbahnhof/Wien Hbf
    const wienTrains = departuresList.filter(departure => {
        const destination = departure.destination?.name?.toLowerCase() || '';
        const direction = departure.direction?.toLowerCase() || '';

        // Check if destination or direction contains Wien keywords
        const wienKeywords = ['wien', 'vienna'];
        const hasWienKeyword = wienKeywords.some(keyword =>
            destination.includes(keyword) || direction.includes(keyword)
        );

        // Also check if it's a train (not bus) going towards Vienna
        const isTrainToVienna = departure.line?.mode === 'train' && hasWienKeyword;

        return isTrainToVienna;
    });

    console.log(`🎯 Found ${wienTrains.length} trains from Bad Vöslau going to Wien Hbf`);

    return {
        station: badVoeslauStation,
        trains: wienTrains
    };
}

async function fetchWienDepartures(hafasClient, signal) {
    console.log('🔍 Searching for Wien Hauptbahnhof...');

    // Prefer the main station explicitly; if no exact hit, force fallback ID 1291501
    const stations = await hafasClient.locations('Wien Hauptbahnhof', {results: 10, signal});

    // Log top candidates for troubleshooting
    if (stations && stations.length) {
        console.log('🧭 Candidate stations:', stations.map(s => `${s.name} (${s.id})`).slice(0, 5).join(' | '));
    }

    let wienStation = stations?.find(station => {
        const name = station.name?.toLowerCase() || '';
        return name.includes('wien hbf') || name.includes('wien hauptbahnhof');
    });

    if (!wienStation) {
        // 1190100 corresponds to Wien (main long-distance hub) and yields RJ/S services
        wienStation = { id: '1190100', name: 'Wien Hbf (forced fallback)' };
    }

    console.log(`📍 Using Wien station: ${wienStation.name} (ID: ${wienStation.id})`);
    console.log('🚂 Fetching departures from Wien...');

    // Get departures for the next few hours
    const departures = await hafasClient.departures(wienStation.id, {
        duration: WIEN_DEPARTURE_DURATION_HOURS * 60, // Convert hours to minutes
        results: MAX_RESULTS_WIEN,
        signal
    });

    // Handle different response formats
    const departuresList = departures.departures || departures || [];
    console.log(`📋 Found ${departuresList.length} total departures from Wien Hbf`);

    // Filter trains that go towards Bad Vöslau / Wr. Neustadt on relevant lines
    const badVoeslauTrains = departuresList.filter(departure => {
        const destination = departure.destination?.name?.toLowerCase() || '';
        const direction = departure.direction?.toLowerCase() || '';
        const trainType = departure.line?.name || '';

        // Broader keyword set to catch common variations
        const routeKeywords = [
            'wr.neustadt',
            'wiener neustadt',
            'bad vöslau',
            'bad voeslau'
        ];

        const hasRouteKeyword = routeKeywords.some(keyword =>
            destination.includes(keyword) || direction.includes(keyword)
        );

        // Only keep southbound lines that actually run via Bad Vöslau
        const isRelevantTrainType = /(REX\s?1|REX\s?3|S\s?3)/.test(trainType);

        return departure.line?.mode === 'train' && hasRouteKeyword && isRelevantTrainType;
    });

    // Debug: show a few departures for validation
    console.log('🧪 Sample Wien departures (first 10):');
    departuresList.slice(0, 10).forEach((d, idx) => {
        console.log(`  ${idx + 1}. ${d.when} → ${d.destination?.name} | dir: ${d.direction} | line: ${d.line?.name} | mode: ${d.line?.mode}`);
    });

    console.log(`🎯 Found ${badVoeslauTrains.length} trains from Wien going to Bad Vöslau area`);

    return {
        station: wienStation,
        trains: badVoeslauTrains
    };
}

function transformTrainData(trains) {
    return trains.map(departure => {
        const scheduledTime = departure.when ? new Date(departure.when) : null;
        const actualTime = departure.delay && scheduledTime ?
            new Date(scheduledTime.getTime() + (departure.delay * 1000)) : null;

        return {
            // Scheduled departure time in HH:MM format
            ti: scheduledTime ? scheduledTime.toLocaleTimeString('de-AT', {
                hour: '2-digit',
                minute: '2-digit',
                timeZone: 'Europe/Vienna'
            }) : 'N/A',

            // Destination
            st: departure.destination?.name || 'Unknown',

            // Train product/type
            pr: departure.line?.name || 'Unknown',

            // Platform
            tr: departure.platform || '',

            // Real-time data if there's a delay
            rt: (departure.delay && departure.delay > 0) ? {
                dlt: actualTime ? actualTime.toLocaleTimeString('de-AT', {
                    hour: '2-digit',
                    minute: '2-digit',
                    timeZone: 'Europe/Vienna'
                }) : null
            } : undefined,

            // Additional useful data
            direction: departure.direction || '',
            delay: departure.delay || 0,
            cancelled: departure.cancelled || false
        };
    });
}

function createDepartureFetcher(hafasClient) {
    return async function fetchDepartures({signal} = {}) {
        const [badVoeslauData, wienData] = await Promise.all([
            fetchBadVoeslauDepartures(hafasClient, signal),
            fetchWienDepartures(hafasClient, signal)
        ]);

        const badVoeslauToWien = transformTrainData(badVoeslauData.trains);
        const wienToBadVoeslau = transformTrainData(wienData.trains);

        const output = {
            badVoeslauToWien,
            wienToBadVoeslau,
            lastUpdated: new Date().toISOString(),
            stations: {
                badVoeslau: {
                    name: badVoeslauData.station.name,
                    id: badVoeslauData.station.id
                },
                wienHbf: {
                    name: wienData.station.name,
                    id: wienData.station.id
                }
            }
        };

        console.log(`✅ Fetched departures at ${output.lastUpdated}`);
        console.log(`🚂 Bad Vöslau → Wien: ${badVoeslauToWien.length} trains`);
        console.log(`🚂 Wien → Bad Vöslau: ${wienToBadVoeslau.length} trains`);

        return output;
    };
}

const fetchDepartures = createDepartureFetcher(hafas);

if (require.main === module) {
    fetchDepartures()
        .then((departures) => console.log(JSON.stringify(departures, null, 2)))
        .catch((error) => {
            console.error('❌ Error fetching departures:', error.message);
            process.exitCode = 1;
        });
}

module.exports = {createDepartureFetcher, fetchDepartures};
