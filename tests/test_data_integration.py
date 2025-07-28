"""Integration tests for data fetching and processing pipeline"""

import subprocess
from typing import Any
from unittest.mock import Mock, patch

from app import fetch_fresh_data, load_departures_data, should_auto_refresh, update_data


class TestFetchFreshData:
    """Tests for fetch_fresh_data function"""

    def test_successful_fetch(self):
        """Test successful data fetch"""
        mock_result = Mock()
        mock_result.returncode = 0
        mock_result.stdout = "Successfully fetched train data"
        mock_result.stderr = ""

        with patch("app.subprocess.run", return_value=mock_result) as mock_run:
            result = fetch_fresh_data()

            assert result is True
            mock_run.assert_called_once_with(
                ["node", "fetch_departures.js"],
                capture_output=True,
                text=True,
                timeout=30,
            )

    def test_failed_fetch_non_zero_exit(self):
        """Test failed data fetch with non-zero exit code"""
        mock_result = Mock()
        mock_result.returncode = 1
        mock_result.stdout = ""
        mock_result.stderr = "Error: API rate limit exceeded"

        with patch("app.subprocess.run", return_value=mock_result):
            result = fetch_fresh_data()

            assert result is False

    def test_fetch_timeout(self):
        """Test data fetch timeout"""
        with patch(
            "app.subprocess.run", side_effect=subprocess.TimeoutExpired("node", 30)
        ):
            result = fetch_fresh_data()

            assert result is False

    def test_fetch_file_not_found(self):
        """Test data fetch when Node.js or script not found"""
        with patch(
            "app.subprocess.run",
            side_effect=FileNotFoundError("node command not found"),
        ):
            result = fetch_fresh_data()

            assert result is False

    def test_fetch_unexpected_error(self):
        """Test data fetch with unexpected error"""
        with patch("app.subprocess.run", side_effect=RuntimeError("Unexpected error")):
            result = fetch_fresh_data()

            assert result is False

    def test_fetch_with_output_logging(self):
        """Test that fetch logs output correctly"""
        mock_result = Mock()
        mock_result.returncode = 0
        mock_result.stdout = "Fetched 5 departures from Bad Vöslau"
        mock_result.stderr = ""

        with (
            patch("app.subprocess.run", return_value=mock_result),
            patch("app.logger") as mock_logger,
        ):
            result = fetch_fresh_data()

            assert result is True
            # Should log the success and debug output
            mock_logger.info.assert_called_with(
                "Successfully fetched fresh departure data"
            )
            mock_logger.debug.assert_called_with(
                f"Node.js output: {mock_result.stdout}"
            )

    def test_fetch_timeout_custom_value(self):
        """Test that fetch uses correct timeout value"""
        mock_result = Mock()
        mock_result.returncode = 0
        mock_result.stdout = "Success"
        mock_result.stderr = ""

        with patch("app.subprocess.run", return_value=mock_result) as mock_run:
            fetch_fresh_data()

            # Check that 30 second timeout is used
            call_args = mock_run.call_args
            assert call_args[1]["timeout"] == 30


class TestUpdateData:
    """Tests for update_data function"""

    def test_successful_update(self):
        """Test successful data update"""
        with (
            patch("app.fetch_fresh_data", return_value=True) as mock_fetch,
            patch("app.st.rerun") as mock_rerun,
            patch("app.logger") as mock_logger,
        ):
            result = update_data()

            assert result is True
            mock_fetch.assert_called_once()
            mock_rerun.assert_called_once()
            mock_logger.info.assert_called_with(
                "Successfully fetched fresh data, reloading"
            )

    def test_failed_update(self):
        """Test failed data update"""
        with (
            patch("app.fetch_fresh_data", return_value=False) as mock_fetch,
            patch("app.st.rerun") as mock_rerun,
            patch("app.logger") as mock_logger,
        ):
            result = update_data()

            assert result is False
            mock_fetch.assert_called_once()
            mock_rerun.assert_not_called()
            mock_logger.warning.assert_called_with(
                "Failed to fetch fresh data, using cached data"
            )


class TestDataPipelineIntegration:
    """Integration tests for the complete data pipeline"""

    def test_complete_pipeline_fresh_data(self, sample_train_data: dict[str, Any]):
        """Test complete pipeline with fresh data"""
        # Mock file operations
        with (
            patch("app.os.path.exists", return_value=True),
            patch("builtins.open", mock_open_json(sample_train_data)),
            patch("app.is_data_stale", return_value=False),
        ):
            # Load data
            data = load_departures_data()
            assert data is not None

            # Check if refresh needed
            should_refresh = should_auto_refresh(data, 60)
            assert should_refresh is False

    def test_complete_pipeline_stale_data(self, stale_train_data: dict[str, Any]):
        """Test complete pipeline with stale data triggering refresh"""
        # Mock file operations
        with (
            patch("app.os.path.exists", return_value=True),
            patch("builtins.open", mock_open_json(stale_train_data)),
            patch("app.is_data_stale", return_value=True),
        ):
            # Load data
            data = load_departures_data()
            assert data is not None

            # Check if refresh needed
            should_refresh = should_auto_refresh(data, 60)
            assert should_refresh is True

    def test_pipeline_with_fetch_and_reload(self, sample_train_data: dict[str, Any]):
        """Test pipeline including fetch and reload cycle"""
        # Mock successful fetch
        mock_subprocess_result = Mock()
        mock_subprocess_result.returncode = 0
        mock_subprocess_result.stdout = "Success"
        mock_subprocess_result.stderr = ""

        with (
            patch("app.subprocess.run", return_value=mock_subprocess_result),
            patch("app.os.path.exists", return_value=True),
            patch("builtins.open", mock_open_json(sample_train_data)),
            patch("app.st.rerun") as mock_rerun,
        ):
            # Fetch fresh data
            fetch_result = fetch_fresh_data()
            assert fetch_result is True

            # Update data (should trigger rerun)
            update_result = update_data()
            assert update_result is True
            mock_rerun.assert_called_once()

    def test_pipeline_error_recovery(self):
        """Test pipeline behavior when fetch fails but cached data exists"""
        # Mock failed fetch but existing cached data
        mock_subprocess_result = Mock()
        mock_subprocess_result.returncode = 1
        mock_subprocess_result.stderr = "API Error"

        cached_data = {
            "badVoeslauToWien": [],
            "wienToBadVoeslau": [],
            "lastUpdated": "",
        }

        with (
            patch("app.subprocess.run", return_value=mock_subprocess_result),
            patch("app.os.path.exists", return_value=True),
            patch("builtins.open", mock_open_json(cached_data)),
            patch("app.st.rerun") as mock_rerun,
        ):
            # Fetch should fail
            fetch_result = fetch_fresh_data()
            assert fetch_result is False

            # Update should fail but not crash
            update_result = update_data()
            assert update_result is False
            mock_rerun.assert_not_called()

            # Should still be able to load cached data
            data = load_departures_data()
            assert data is not None

    def test_pipeline_no_cached_data_fetch_fails(self):
        """Test pipeline when no cached data and fetch fails"""
        # Mock failed fetch and no cached file
        mock_subprocess_result = Mock()
        mock_subprocess_result.returncode = 1
        mock_subprocess_result.stderr = "API Error"

        with (
            patch("app.subprocess.run", return_value=mock_subprocess_result),
            patch("app.os.path.exists", return_value=False),
            patch("app.st.rerun") as mock_rerun,
        ):
            # Fetch should fail
            fetch_result = fetch_fresh_data()
            assert fetch_result is False

            # Load should fail (no file)
            data = load_departures_data()
            assert data is None

            # Update should fail
            update_result = update_data()
            assert update_result is False
            mock_rerun.assert_not_called()


class TestDataFormatMigration:
    """Tests for data format migration during pipeline operation"""

    def test_old_to_new_format_conversion(self, old_format_train_data: dict[str, Any]):
        """Test that old format data is properly converted in the pipeline"""
        with (
            patch("app.os.path.exists", return_value=True),
            patch("builtins.open", mock_open_json(old_format_train_data)),
        ):
            # Load data - should convert old format
            data = load_departures_data()
            assert data is not None

            # Should be in new format now
            assert "badVoeslauToWien" in data
            assert "wienToBadVoeslau" in data
            assert data["badVoeslauToWien"] == old_format_train_data["journey"]
            assert data["wienToBadVoeslau"] == []

    def test_mixed_format_handling(self):
        """Test handling of mixed or partially invalid format data"""
        mixed_data = {
            "journey": [{"ti": "10:17"}],  # Old format key
            "badVoeslauToWien": [{"ti": "10:47"}],  # New format key
            "lastUpdated": "2025-07-27T08:11:19.908Z",
        }

        with (
            patch("app.os.path.exists", return_value=True),
            patch("builtins.open", mock_open_json(mixed_data)),
        ):
            data = load_departures_data()
            assert data is not None

            # Should prioritize old format conversion if "journey" key exists
            assert "badVoeslauToWien" in data
            assert data["badVoeslauToWien"] == mixed_data["journey"]


# Helper function for mocking JSON file operations
def mock_open_json(json_data: Any) -> Any:
    """Create a mock for open() that returns JSON data"""
    import json
    from unittest.mock import mock_open

    return mock_open(read_data=json.dumps(json_data))


class TestRealTimeDataProcessing:
    """Tests for real-time data processing in the pipeline"""

    def test_realtime_delay_processing(self):
        """Test processing of real-time delay information"""
        data_with_delays = {
            "badVoeslauToWien": [
                {
                    "ti": "10:17",
                    "st": "Wien Hauptbahnhof",
                    "pr": "REX 3",
                    "tr": "1",
                    "rt": {"dlt": "10:22"},  # 5 minute delay
                },
                {
                    "ti": "10:47",
                    "st": "Wien Hauptbahnhof",
                    "pr": "REX 3",
                    "tr": "2",
                    # No rt data - on time
                },
            ],
            "wienToBadVoeslau": [],
            "lastUpdated": "2025-07-27T08:11:19.908Z",
            "stations": {},
        }

        with (
            patch("app.os.path.exists", return_value=True),
            patch("builtins.open", mock_open_json(data_with_delays)),
        ):
            data = load_departures_data()
            assert data is not None

            trains = data["badVoeslauToWien"]

            # Test delay calculation for real-time data
            from app import calculate_delay

            # First train has delay
            delay1 = calculate_delay(trains[0]["ti"], trains[0]["rt"]["dlt"])
            assert delay1 == 5

            # Second train has no real-time data
            delay2 = calculate_delay(
                trains[1]["ti"], trains[1].get("rt", {}).get("dlt")
            )
            assert delay2 == 0

    def test_missing_realtime_data(self):
        """Test handling when real-time data is missing or malformed"""
        data_missing_rt = {
            "badVoeslauToWien": [
                {
                    "ti": "10:17",
                    "st": "Wien Hauptbahnhof",
                    "pr": "REX 3",
                    "tr": "1",
                    "rt": {},  # Empty rt object
                },
                {
                    "ti": "10:47",
                    "st": "Wien Hauptbahnhof",
                    "pr": "REX 3",
                    "tr": "2",
                    "rt": {"dlt": None},  # Null dlt value
                },
            ],
            "wienToBadVoeslau": [],
            "lastUpdated": "2025-07-27T08:11:19.908Z",
            "stations": {},
        }

        with (
            patch("app.os.path.exists", return_value=True),
            patch("builtins.open", mock_open_json(data_missing_rt)),
        ):
            data = load_departures_data()
            assert data is not None

            # Should handle missing/malformed rt data gracefully
            trains = data["badVoeslauToWien"]
            assert len(trains) == 2

            # Both should be treated as on-time due to missing rt data
            from app import calculate_delay

            for train in trains:
                rt_time = train.get("rt", {}).get("dlt")
                delay = calculate_delay(train["ti"], rt_time)
                assert delay == 0
