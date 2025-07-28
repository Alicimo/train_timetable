"""Tests for core data processing business logic"""

import json
from datetime import datetime, timezone
from typing import Any
from unittest.mock import mock_open, patch

from app import (
    calculate_delay,
    format_last_updated_display,
    format_time,
    is_data_stale,
    load_departures_data,
    should_auto_refresh,
)


class TestLoadDeparturesData:
    """Tests for load_departures_data function"""

    def test_load_valid_new_format_data(
        self, sample_train_data: dict[str, Any], temp_json_file: Any
    ) -> None:
        """Test loading valid data in new bidirectional format"""
        temp_json_file(sample_train_data)  # Create temp file

        with (
            patch("app.os.path.exists", return_value=True),
            patch("builtins.open", mock_open(read_data=json.dumps(sample_train_data))),
        ):
            result = load_departures_data()

        assert result is not None
        assert result == sample_train_data
        assert "badVoeslauToWien" in result
        assert "wienToBadVoeslau" in result
        assert len(result["badVoeslauToWien"]) == 3
        assert len(result["wienToBadVoeslau"]) == 2

    def test_load_old_format_conversion(self, old_format_train_data: dict[str, Any]):
        """Test loading and converting old format data"""
        with (
            patch("app.os.path.exists", return_value=True),
            patch(
                "builtins.open", mock_open(read_data=json.dumps(old_format_train_data))
            ),
        ):
            result = load_departures_data()

        assert result is not None
        # Should be converted to new format
        assert "badVoeslauToWien" in result
        assert "wienToBadVoeslau" in result
        assert result["badVoeslauToWien"] == old_format_train_data["journey"]
        assert result["wienToBadVoeslau"] == []
        assert result["lastUpdated"] == old_format_train_data["lastUpdated"]

    def test_load_missing_file(self):
        """Test handling of missing JSON file"""
        with patch("app.os.path.exists", return_value=False):
            result = load_departures_data()

        assert result is None

    def test_load_invalid_json(self, invalid_json_content: str):
        """Test handling of invalid JSON content"""
        with (
            patch("app.os.path.exists", return_value=True),
            patch("builtins.open", mock_open(read_data=invalid_json_content)),
        ):
            result = load_departures_data()

        assert result is None

    def test_load_file_read_error(self):
        """Test handling of file read errors"""
        with (
            patch("app.os.path.exists", return_value=True),
            patch("builtins.open", side_effect=IOError("Permission denied")),
        ):
            result = load_departures_data()

        assert result is None

    def test_load_empty_data(self, empty_train_data: dict[str, Any]):
        """Test loading empty but valid data"""
        with (
            patch("app.os.path.exists", return_value=True),
            patch("builtins.open", mock_open(read_data=json.dumps(empty_train_data))),
        ):
            result = load_departures_data()

        assert result is not None
        assert result == empty_train_data
        assert len(result["badVoeslauToWien"]) == 0
        assert len(result["wienToBadVoeslau"]) == 0


class TestFormatTime:
    """Tests for format_time function"""

    def test_format_valid_time(self):
        """Test formatting valid time string"""
        assert format_time("10:17") == "10:17"
        assert format_time("23:59") == "23:59"
        assert format_time("00:00") == "00:00"

    def test_format_none_time(self):
        """Test formatting None time"""
        assert format_time(None) == "N/A"

    def test_format_empty_time(self):
        """Test formatting empty time string"""
        assert format_time("") == "N/A"  # Empty string is falsy, so returns N/A


class TestIsDataStale:
    """Tests for is_data_stale function"""

    def test_data_not_stale(self, sample_train_data: dict[str, Any]):
        """Test fresh data is not considered stale"""
        # Use current time
        current_iso = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        data = sample_train_data.copy()
        data["lastUpdated"] = current_iso

        result = is_data_stale(data, max_age_seconds=300)
        assert result is False

    def test_data_is_stale(self, stale_train_data: dict[str, Any]):
        """Test old data is considered stale"""
        result = is_data_stale(stale_train_data, max_age_seconds=60)
        assert result is True

    def test_data_none(self):
        """Test None data is considered stale"""
        result = is_data_stale(None, max_age_seconds=60)
        assert result is True

    def test_missing_timestamp(self, sample_train_data: dict[str, Any]):
        """Test data without timestamp is considered stale"""
        data = sample_train_data.copy()
        del data["lastUpdated"]

        result = is_data_stale(data, max_age_seconds=60)
        assert result is True

    def test_empty_timestamp(self, sample_train_data: dict[str, Any]):
        """Test data with empty timestamp is considered stale"""
        data = sample_train_data.copy()
        data["lastUpdated"] = ""

        result = is_data_stale(data, max_age_seconds=60)
        assert result is True

    def test_invalid_timestamp(self, sample_train_data: dict[str, Any]):
        """Test data with invalid timestamp is considered stale"""
        data = sample_train_data.copy()
        data["lastUpdated"] = "invalid-timestamp"

        result = is_data_stale(data, max_age_seconds=60)
        assert result is True

    def test_exactly_at_limit(self, sample_train_data: dict[str, Any]):
        """Test data exactly at the staleness limit"""
        from datetime import timedelta

        # Create timestamp exactly 61 seconds ago to ensure it's stale
        past_time = datetime.now(timezone.utc) - timedelta(seconds=61)
        data = sample_train_data.copy()
        data["lastUpdated"] = past_time.isoformat().replace("+00:00", "Z")

        result = is_data_stale(data, max_age_seconds=60)
        # Should be stale
        assert result is True


class TestCalculateDelay:
    """Tests for calculate_delay function"""

    def test_no_delay(self):
        """Test calculation when no delay"""
        result = calculate_delay("10:17", "10:17")
        assert result == 0

    def test_positive_delay(self):
        """Test calculation with positive delay"""
        result = calculate_delay("10:17", "10:19")
        assert result == 2

    def test_large_delay(self):
        """Test calculation with large delay"""
        result = calculate_delay("10:17", "10:32")
        assert result == 15

    def test_delay_across_hour(self):
        """Test delay calculation across hour boundary"""
        result = calculate_delay("09:58", "10:03")
        assert result == 5

    def test_none_actual_time(self):
        """Test calculation with None actual time"""
        result = calculate_delay("10:17", None)
        assert result == 0

    def test_none_scheduled_time(self):
        """Test calculation with None scheduled time"""
        result = calculate_delay(None, "10:19")
        assert result == 0

    def test_both_none(self):
        """Test calculation with both times None"""
        result = calculate_delay(None, None)
        assert result == 0

    def test_invalid_time_format(self):
        """Test calculation with invalid time format"""
        result = calculate_delay("invalid", "10:19")
        assert result == 0

        result = calculate_delay("10:17", "invalid")
        assert result == 0

    def test_early_arrival(self):
        """Test calculation when train arrives early (negative delay)"""
        result = calculate_delay("10:17", "10:15")
        assert result == -2


class TestFormatLastUpdatedDisplay:
    """Tests for format_last_updated_display function"""

    def test_valid_timestamp(self):
        """Test formatting valid timestamp"""
        timestamp = "2025-07-27T08:11:19.908Z"
        result = format_last_updated_display(timestamp)
        assert result is not None
        assert ":" in result  # Should contain time separator
        assert len(result) == 8  # HH:MM:SS format

    def test_empty_timestamp(self):
        """Test formatting empty timestamp"""
        result = format_last_updated_display("")
        assert result is None

    def test_none_timestamp(self):
        """Test formatting None timestamp"""
        result = format_last_updated_display(None)
        assert result is None

    def test_invalid_timestamp(self):
        """Test formatting invalid timestamp"""
        result = format_last_updated_display("invalid-timestamp")
        assert result is None

    def test_timestamp_with_timezone(self):
        """Test formatting timestamp with different timezone format"""
        timestamp = "2025-07-27T08:11:19+00:00"
        result = format_last_updated_display(timestamp)
        assert result is not None
        assert ":" in result


class TestShouldAutoRefresh:
    """Tests for should_auto_refresh function"""

    def test_should_refresh_stale_data(self, stale_train_data: dict[str, Any]):
        """Test that stale data triggers auto refresh"""
        result = should_auto_refresh(stale_train_data, refresh_interval=60)
        assert result is True

    def test_should_not_refresh_fresh_data(self, sample_train_data: dict[str, Any]):
        """Test that fresh data does not trigger auto refresh"""
        # Update timestamp to current time
        current_iso = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        data = sample_train_data.copy()
        data["lastUpdated"] = current_iso

        result = should_auto_refresh(data, refresh_interval=300)
        assert result is False

    def test_should_not_refresh_none_data(self):
        """Test that None data does not trigger auto refresh"""
        result = should_auto_refresh(None, refresh_interval=60)
        assert result is False

    def test_custom_refresh_interval(self, sample_train_data: dict[str, Any]):
        """Test with custom refresh interval"""
        from datetime import timedelta

        # Create data that's 30 seconds old
        past_time = datetime.now(timezone.utc) - timedelta(seconds=30)
        data = sample_train_data.copy()
        data["lastUpdated"] = past_time.isoformat().replace("+00:00", "Z")

        # Should not refresh with 60s interval
        result = should_auto_refresh(data, refresh_interval=60)
        assert result is False

        # Should refresh with 20s interval
        result = should_auto_refresh(data, refresh_interval=20)
        assert result is True
