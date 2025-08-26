#!/usr/bin/env node

const {createClient} = require('hafas-client');
const {profile} = require('hafas-client/p/oebb/index.js');
const fs = require('fs');

const hafas = createClient(profile, 'train-updates-app (github.com/user/train_updates)');

// Configuration constants
const DEPARTURE_DURATION_HOURS = 2;
const WIEN_DEPARTURE_DURATION_HOURS = 2;
const MAX_RESULTS_BAD_VOESLAU = 20;
const MAX_RESULTS_WIEN = 100;

async function fetchBadVoeslauDepartures() {
    console.log('🔍 Searching for Bad Vöslau station...');

    // Search for Bad Vöslau station
    const stations = await hafas.locations('Bad Vöslau', { results: 5 });

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
    const departures = await hafas.departures(badVoeslauStation.id, {
        duration: DEPARTURE_DURATION_HOURS * 60, // Convert hours to minutes
        results: MAX_RESULTS_BAD_VOESLAU
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

async function fetchWienDepartures() {
    console.log('🔍 Searching for Wien station...');

    // Search for Wien station
    const stations = await hafas.locations('Wien', { results: 5 });

    if (!stations || stations.length === 0) {
        throw new Error('No stations found for Wien');
    }

    // Find Wien station (use first result as it's typically the main station)
    const wienStation = stations.find(station =>
        station.name && station.name.toLowerCase() === 'wien'
    ) || stations[0];

    console.log(`📍 Found Wien station: ${wienStation.name} (ID: ${wienStation.id})`);
    console.log('🚂 Fetching departures from Wien...');

    // Get departures for the next few hours
    const departures = await hafas.departures(wienStation.id, {
        duration: WIEN_DEPARTURE_DURATION_HOURS * 60, // Convert hours to minutes
        results: MAX_RESULTS_WIEN
    });

    // Handle different response formats
    const departuresList = departures.departures || departures || [];
    console.log(`📋 Found ${departuresList.length} total departures from Wien Hbf`);

    // Filter trains that go to Bad Vöslau area (via Wr.Neustadt) with specific train types
    const badVoeslauTrains = departuresList.filter(departure => {
        const destination = departure.destination?.name?.toLowerCase() || '';
        const direction = departure.direction?.toLowerCase() || '';
        const trainType = departure.line?.name || '';

        // Check if destination contains routes that serve Bad Vöslau
        const routeKeywords = ['wr.neustadt hbf'];
        const hasRouteKeyword = routeKeywords.some(keyword =>
            destination.includes(keyword) || direction.includes(keyword)
        );

        // Check if it's the right train type (REX 3 or S 4)
        const isRelevantTrainType = trainType.includes('REX 3') || trainType.includes('S 4');

        // Check if it's a train (not bus) on the route with the right type
        return departure.line?.mode === 'train' && hasRouteKeyword && isRelevantTrainType;
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

async function fetchDepartures() {
    try {
        // Fetch both directions
        const [badVoeslauData, wienData] = await Promise.allSettled([
            fetchBadVoeslauDepartures(),
            fetchWienDepartures()
        ]);

        // Handle Bad Vöslau → Wien results
        let badVoeslauToWien = [];
        let badVoeslauStation = null;
        if (badVoeslauData.status === 'fulfilled') {
            badVoeslauToWien = transformTrainData(badVoeslauData.value.trains);
            badVoeslauStation = badVoeslauData.value.station;
        } else {
            console.error('❌ Error fetching Bad Vöslau departures:', badVoeslauData.reason.message);
        }

        // Handle Wien → Bad Vöslau results
        let wienToBadVoeslau = [];
        let wienStation = null;
        if (wienData.status === 'fulfilled') {
            wienToBadVoeslau = transformTrainData(wienData.value.trains);
            wienStation = wienData.value.station;
        } else {
            console.error('❌ Error fetching Wien departures:', wienData.reason.message);
        }

        // Create output structure with both directions
        const output = {
            badVoeslauToWien,
            wienToBadVoeslau,
            lastUpdated: new Date().toISOString(),
            stations: {
                badVoeslau: badVoeslauStation ? {
                    name: badVoeslauStation.name,
                    id: badVoeslauStation.id
                } : null,
                wienHbf: wienStation ? {
                    name: wienStation.name,
                    id: wienStation.id
                } : null
            }
        };

        // Write to JSON file
        const outputFile = 'departures.json';
        fs.writeFileSync(outputFile, JSON.stringify(output, null, 2));

        console.log(`✅ Successfully saved train departures to ${outputFile}`);
        console.log(`📅 Last updated: ${output.lastUpdated}`);
        console.log(`🚂 Bad Vöslau → Wien: ${badVoeslauToWien.length} trains`);
        console.log(`🚂 Wien → Bad Vöslau: ${wienToBadVoeslau.length} trains`);

        // Show examples from both directions
        if (badVoeslauToWien.length > 0) {
            console.log('\n📊 Sample Bad Vöslau → Wien departures:');
            badVoeslauToWien.slice(0, 2).forEach((train, index) => {
                const delayText = train.delay > 0 ? ` (+${train.delay / 60}min)` : '';
                console.log(`  ${index + 1}. ${train.ti}${delayText} → ${train.st} (${train.pr})`);
            });
        }

        if (wienToBadVoeslau.length > 0) {
            console.log('\n📊 Sample Wien → Bad Vöslau departures:');
            wienToBadVoeslau.slice(0, 2).forEach((train, index) => {
                const delayText = train.delay > 0 ? ` (+${train.delay / 60}min)` : '';
                console.log(`  ${index + 1}. ${train.ti}${delayText} → ${train.st} (${train.pr})`);
            });
        }

        // Exit with error if no data was fetched successfully
        if (badVoeslauToWien.length === 0 && wienToBadVoeslau.length === 0) {
            console.error('❌ No train data was fetched successfully for either direction');
            process.exit(1);
        }

    } catch (error) {
        console.error('❌ Error fetching departures:', error.message);
        process.exit(1);
    }
}

// Run the script
if (require.main === module) {
    fetchDepartures();
}

module.exports = { fetchDepartures };