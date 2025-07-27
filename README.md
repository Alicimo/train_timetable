# Bad Vöslau → Wien Hbf Train Updates

A real-time train departure app showing trains from Bad Vöslau to Vienna Central Station (Wien Hauptbahnhof).

## Architecture

**Node.js Data Fetcher** + **Python Streamlit UI** = Reliable Train Data

- **`fetch_departures.js`**: Uses `oebb-hafas` library to fetch live departure data
- **`app.py`**: Streamlit web app that displays the data with filtering and UI
- **`departures.json`**: JSON data file that bridges the two components

## Quick Start

```bash
# Run the complete app (fetches data + starts UI)
./run_app.sh

# Or run components separately:
node fetch_departures.js  # Fetch latest data
uv run streamlit run app.py  # Start web UI
```

## Development Commands

```bash
# Python development
uv run ruff format .        # Format code
uv run ruff check .         # Lint code
uv run pytest              # Run tests

# Node.js development  
npm install                 # Install dependencies
node fetch_departures.js   # Test data fetching
```

## Dependencies

- **Node.js**: `oebb-hafas` for reliable ÖBB API access
- **Python**: `streamlit`, `pandas`, `loguru`, `pytz` for the web interface

## Features

- ✅ Live departure times from Bad Vöslau
- ✅ Filtered for trains going to Vienna (Wien)
- ✅ Real-time delay information
- ✅ Clean, responsive web interface
- ✅ Auto-refresh functionality
- ✅ Platform and train type information

## Benefits of New Architecture

- **Reliability**: Uses well-tested `hafas-client` library instead of custom API implementation
- **Maintainability**: Separation of concerns - Node.js handles API complexity, Python handles UI
- **Performance**: Pre-filtered data reduces processing time
- **Debugging**: Easier to troubleshoot issues in focused components

## How It Works

1. **Data Fetching**: Node.js script queries ÖBB HAFAS API for Bad Vöslau departures
2. **Filtering**: Filters for trains going to Vienna (Wien Praterstern Bahnhof and similar)
3. **Data Bridge**: Saves filtered results to `departures.json`
4. **UI Display**: Python Streamlit app reads JSON and presents clean interface
5. **Auto-refresh**: UI automatically refreshes data at configurable intervals