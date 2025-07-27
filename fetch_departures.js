#!/usr/bin/env node

const hafas = require('oebb-hafas')('train-updates-app (github.com/user/train_updates)');
const fs = require('fs');

async function fetchDepartures() {
    try {
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

        console.log(`📍 Found station: ${badVoeslauStation.name} (ID: ${badVoeslauStation.id})`);

        console.log('🚂 Fetching departures...');

        // Get departures for the next few hours
        const now = new Date();
        const departures = await hafas.departures(badVoeslauStation.id, {
            duration: 120, // 2 hours
            results: 10
        });

        // console.log('📋 Departures response:', departures);

        // Handle different response formats
        const departuresList = departures.departures || departures || [];
        console.log(`📋 Found ${departuresList.length} total departures`);

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

        console.log(`🎯 Found ${wienTrains.length} trains going to Wien Hbf`);

        // Transform data to match the format expected by the Python app
        const trainData = wienTrains.map(departure => {
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

        // Create output structure matching what Python app expects
        const output = {
            journey: trainData,
            lastUpdated: new Date().toISOString(),
            station: {
                name: badVoeslauStation.name,
                id: badVoeslauStation.id
            }
        };

        // Write to JSON file
        const outputFile = 'departures.json';
        fs.writeFileSync(outputFile, JSON.stringify(output, null, 2));

        console.log(`✅ Successfully saved ${trainData.length} Wien Hbf departures to ${outputFile}`);
        console.log(`📅 Last updated: ${output.lastUpdated}`);

        // Show a few examples
        if (trainData.length > 0) {
            console.log('\n📊 Sample departures:');
            trainData.slice(0, 3).forEach((train, index) => {
                const delayText = train.delay > 0 ? ` (+${train.delay / 60}min)` : '';
                console.log(`  ${index + 1}. ${train.ti}${delayText} → ${train.st} (${train.pr})`);
            });
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