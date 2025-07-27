#!/bin/bash

echo "🚂 Bad Vöslau → Wien Hbf Train Updates"
echo "=================================="

echo "📡 Fetching latest train data..."
node fetch_departures.js

if [ $? -eq 0 ]; then
    echo ""
    echo "🚀 Starting Streamlit app..."
    echo "📍 Open http://localhost:8501 in your browser"
    echo ""
    uv run streamlit run app.py --server.port 8501
else
    echo "❌ Failed to fetch train data. Please check the Node.js script."
    exit 1
fi