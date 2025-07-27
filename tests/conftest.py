"""Test fixtures for train_updates application"""

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pytest
import pytz


@pytest.fixture
def sample_train_data() -> dict[str, Any]:
    """Sample train data in the new bidirectional format"""
    return {
        "badVoeslauToWien": [
            {
                "ti": "10:17",
                "st": "Wien Praterstern Bahnhof",
                "pr": "REX 3 (Zug-Nr. 19222)",
                "tr": "2",
                "rt": {"dlt": "10:19"},
                "direction": "Wien Hauptbahnhof",
                "delay": 120,
                "cancelled": False
            },
            {
                "ti": "10:47",
                "st": "Wien Hauptbahnhof",
                "pr": "REX 3 (Zug-Nr. 19224)",
                "tr": "1",
                "direction": "Wien Hauptbahnhof",
                "delay": 0,
                "cancelled": False
            },
            {
                "ti": "11:17",
                "st": "Wien Praterstern Bahnhof",
                "pr": "REX 3 (Zug-Nr. 19226)",
                "tr": "2",
                "rt": {"dlt": "11:22"},
                "direction": "Wien Hauptbahnhof",
                "delay": 300,
                "cancelled": False
            }
        ],
        "wienToBadVoeslau": [
            {
                "ti": "15:30",
                "st": "Bad Vöslau Bahnhof",
                "pr": "REX 3 (Zug-Nr. 19251)",
                "tr": "3",
                "direction": "Bad Vöslau",
                "delay": 0,
                "cancelled": False
            },
            {
                "ti": "16:00",
                "st": "Bad Vöslau Bahnhof", 
                "pr": "REX 3 (Zug-Nr. 19253)",
                "tr": "3",
                "rt": {"dlt": "16:03"},
                "direction": "Bad Vöslau",
                "delay": 180,
                "cancelled": False
            }
        ],
        "lastUpdated": "2025-07-27T08:11:19.908Z",
        "stations": {
            "badVoeslau": {"name": "Bad Vöslau", "id": "1130603"},
            "wienHbf": {"name": "Wien Hauptbahnhof", "id": "1291501"}
        }
    }


@pytest.fixture
def old_format_train_data() -> dict[str, Any]:
    """Sample train data in the old format (for backward compatibility testing)"""
    return {
        "journey": [
            {
                "ti": "10:17",
                "st": "Wien Praterstern Bahnhof",
                "pr": "REX 3 (Zug-Nr. 19222)",
                "tr": "2",
                "rt": {"dlt": "10:19"},
                "direction": "Wien Hauptbahnhof",
                "delay": 120,
                "cancelled": False
            },
            {
                "ti": "10:47",
                "st": "Wien Hauptbahnhof",
                "pr": "REX 3 (Zug-Nr. 19224)",
                "tr": "1",
                "direction": "Wien Hauptbahnhof",
                "delay": 0,
                "cancelled": False
            }
        ],
        "lastUpdated": "2025-07-27T08:11:19.908Z",
        "station": {"name": "Bad Vöslau", "id": "1130603"}
    }


@pytest.fixture
def malformed_train_data() -> dict[str, Any]:
    """Malformed train data for error testing"""
    return {
        "badVoeslauToWien": [
            {
                "ti": "invalid-time",
                "st": "Wien Praterstern Bahnhof",
                "pr": "REX 3 (Zug-Nr. 19222)",
                "tr": None,
                "rt": {"dlt": "also-invalid"},
                "direction": "Wien Hauptbahnhof",
                "delay": "not-a-number",
                "cancelled": "not-a-boolean"
            }
        ],
        "wienToBadVoeslau": [],
        "lastUpdated": "invalid-timestamp",
        "stations": {}
    }


@pytest.fixture
def empty_train_data() -> dict[str, Any]:
    """Empty train data"""
    return {
        "badVoeslauToWien": [],
        "wienToBadVoeslau": [],
        "lastUpdated": "2025-07-27T08:11:19.908Z",
        "stations": {
            "badVoeslau": {"name": "Bad Vöslau", "id": "1130603"},
            "wienHbf": {"name": "Wien Hauptbahnhof", "id": "1291501"}
        }
    }


@pytest.fixture
def stale_train_data() -> dict[str, Any]:
    """Train data that is older than typical refresh interval"""
    # Create timestamp from 2 hours ago
    stale_time = datetime.now(timezone.utc).replace(hour=datetime.now(timezone.utc).hour - 2)
    
    return {
        "badVoeslauToWien": [
            {
                "ti": "10:17",
                "st": "Wien Praterstern Bahnhof",
                "pr": "REX 3 (Zug-Nr. 19222)",
                "tr": "2",
                "direction": "Wien Hauptbahnhof",
                "delay": 0,
                "cancelled": False
            }
        ],
        "wienToBadVoeslau": [],
        "lastUpdated": stale_time.isoformat().replace("+00:00", "Z"),
        "stations": {
            "badVoeslau": {"name": "Bad Vöslau", "id": "1130603"},
            "wienHbf": {"name": "Wien Hauptbahnhof", "id": "1291501"}
        }
    }


@pytest.fixture
def temp_json_file(tmp_path: Path):
    """Create a temporary JSON file for testing file operations"""
    def _create_temp_file(data: dict[str, Any]) -> Path:
        temp_file = tmp_path / "test_departures.json"
        with open(temp_file, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
        return temp_file
    return _create_temp_file


@pytest.fixture
def vienna_timezone():
    """Vienna timezone fixture"""
    return pytz.timezone("Europe/Vienna")


@pytest.fixture
def mock_datetime_morning():
    """Mock datetime for morning time (before 12:00)"""
    vienna_tz = pytz.timezone("Europe/Vienna")
    return datetime(2025, 7, 27, 9, 30, 0, tzinfo=vienna_tz)


@pytest.fixture
def mock_datetime_afternoon():
    """Mock datetime for afternoon time (after 12:00)"""
    vienna_tz = pytz.timezone("Europe/Vienna")
    return datetime(2025, 7, 27, 15, 30, 0, tzinfo=vienna_tz)


@pytest.fixture
def mock_current_time():
    """Current time for testing time-dependent functions"""
    return datetime(2025, 7, 27, 10, 30, 0, tzinfo=timezone.utc)


@pytest.fixture
def invalid_json_content() -> str:
    """Invalid JSON content for error testing"""
    return '{"badVoeslauToWien": [invalid json content'


@pytest.fixture
def minimal_valid_data() -> dict[str, Any]:
    """Minimal valid data structure"""
    return {
        "badVoeslauToWien": [],
        "wienToBadVoeslau": [],
        "lastUpdated": "",
        "stations": {}
    }