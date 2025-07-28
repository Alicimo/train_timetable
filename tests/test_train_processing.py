"""Tests for train data processing and transformation logic"""

from datetime import datetime
from typing import Any
from unittest.mock import MagicMock, patch

import pandas as pd

from app import (
    create_train_table,
    determine_tab_order,
    get_direction_data,
)


class TestCreateTrainTable:
    """Tests for create_train_table function"""

    def test_create_table_with_valid_data(self, sample_train_data: dict[str, Any]):
        """Test creating train table with valid data"""
        trains = sample_train_data["badVoeslauToWien"]

        # Mock streamlit components
        with patch("app.st") as mock_st:
            mock_st.warning = MagicMock()
            mock_st.dataframe = MagicMock()
            mock_st.column_config = MagicMock()
            mock_st.column_config.TextColumn = MagicMock()

            create_train_table(trains, "Bad Vöslau → Wien")

            # Should call dataframe, not warning
            mock_st.dataframe.assert_called_once()
            mock_st.warning.assert_not_called()

            # Check that DataFrame was created with correct data
            call_args = mock_st.dataframe.call_args
            df = call_args[0][0]

            assert isinstance(df, pd.DataFrame)
            assert len(df) == 3  # Three trains in sample data
            assert "Departure" in df.columns
            assert "Actual" in df.columns
            assert "Delay (min)" in df.columns
            assert "Train" in df.columns
            assert "Platform" in df.columns

    def test_create_table_with_empty_data(self):
        """Test creating train table with empty data"""
        trains = []

        with patch("app.st") as mock_st:
            mock_st.warning = MagicMock()
            mock_st.dataframe = MagicMock()

            create_train_table(trains, "Bad Vöslau → Wien")

            # Should show warning, not dataframe
            mock_st.warning.assert_called_once()
            mock_st.dataframe.assert_not_called()

    def test_create_table_data_formatting(self, sample_train_data: dict[str, Any]):
        """Test that data is formatted correctly in the table"""
        trains = sample_train_data["badVoeslauToWien"]

        with patch("app.st") as mock_st:
            mock_st.warning = MagicMock()
            mock_st.dataframe = MagicMock()
            mock_st.column_config = MagicMock()
            mock_st.column_config.TextColumn = MagicMock()

            create_train_table(trains, "Bad Vöslau → Wien")

            # Get the DataFrame that was passed to st.dataframe
            call_args = mock_st.dataframe.call_args
            df = call_args[0][0]

            # Check first row (delayed train)
            first_row = df.iloc[0]
            assert first_row["Departure"] == "10:17"
            assert first_row["Actual"] == "10:19"  # Has real-time data
            assert first_row["Delay (min)"] == "2"  # 2 minute delay
            assert first_row["Train"] == "REX 3 (Zug-Nr. 19222)"
            assert first_row["Platform"] == "2"

            # Check second row (on-time train)
            second_row = df.iloc[1]
            assert second_row["Departure"] == "10:47"
            assert second_row["Actual"] == "✓ On time"  # No real-time data
            assert second_row["Delay (min)"] == "—"  # No delay indicator
            assert second_row["Train"] == "REX 3 (Zug-Nr. 19224)"
            assert second_row["Platform"] == "1"

    def test_create_table_missing_fields(self):
        """Test creating table with trains missing some fields"""
        trains = [
            {
                "ti": "10:17",
                # Missing 'st', 'pr', 'tr' fields
            },
            {
                "ti": "10:47",
                "st": "Wien Hauptbahnhof",
                "pr": "REX 3 (Zug-Nr. 19224)",
                # Missing 'tr' field
            },
        ]

        with patch("app.st") as mock_st:
            mock_st.warning = MagicMock()
            mock_st.dataframe = MagicMock()
            mock_st.column_config = MagicMock()
            mock_st.column_config.TextColumn = MagicMock()

            create_train_table(trains, "Test Direction")

            # Should still create dataframe
            mock_st.dataframe.assert_called_once()

            call_args = mock_st.dataframe.call_args
            df = call_args[0][0]

            # Check that missing fields are handled gracefully
            first_row = df.iloc[0]
            assert first_row["Departure"] == "10:17"
            assert first_row["Train"] == "Unknown"  # Default for missing 'pr'
            assert first_row["Platform"] == "TBA"  # Default for missing 'tr'

            second_row = df.iloc[1]
            assert second_row["Platform"] == "TBA"  # Missing 'tr'

    def test_create_table_with_delays(self):
        """Test table creation with various delay scenarios"""
        trains = [
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
                # No real-time data - on time
            },
            {
                "ti": "11:17",
                "st": "Wien Hauptbahnhof",
                "pr": "REX 3",
                "tr": "1",
                "rt": {"dlt": "11:12"},  # Early arrival (-5 minutes)
            },
        ]

        with patch("app.st") as mock_st:
            mock_st.warning = MagicMock()
            mock_st.dataframe = MagicMock()
            mock_st.column_config = MagicMock()
            mock_st.column_config.TextColumn = MagicMock()

            create_train_table(trains, "Test Direction")

            call_args = mock_st.dataframe.call_args
            df = call_args[0][0]

            # Check delay calculations
            assert df.iloc[0]["Delay (min)"] == "5"  # Delayed
            assert df.iloc[1]["Delay (min)"] == "—"  # On time
            assert (
                df.iloc[2]["Delay (min)"] == "—"
            )  # Early (negative delay shows as no delay)


class TestGetDirectionData:
    """Tests for get_direction_data function"""

    def test_get_direction_data_valid(self, sample_train_data: dict[str, Any]):
        """Test extracting direction data from valid dataset"""
        bad_voeslau_to_wien, wien_to_bad_voeslau = get_direction_data(sample_train_data)

        assert len(bad_voeslau_to_wien) == 3
        assert len(wien_to_bad_voeslau) == 2
        assert bad_voeslau_to_wien == sample_train_data["badVoeslauToWien"]
        assert wien_to_bad_voeslau == sample_train_data["wienToBadVoeslau"]

    def test_get_direction_data_empty(self, empty_train_data: dict[str, Any]):
        """Test extracting direction data from empty dataset"""
        bad_voeslau_to_wien, wien_to_bad_voeslau = get_direction_data(empty_train_data)

        assert len(bad_voeslau_to_wien) == 0
        assert len(wien_to_bad_voeslau) == 0

    def test_get_direction_data_none(self):
        """Test extracting direction data from None"""
        bad_voeslau_to_wien, wien_to_bad_voeslau = get_direction_data(None)

        assert len(bad_voeslau_to_wien) == 0
        assert len(wien_to_bad_voeslau) == 0

    def test_get_direction_data_missing_keys(self):
        """Test extracting direction data with missing keys"""
        data = {"lastUpdated": "2025-07-27T08:11:19.908Z"}
        bad_voeslau_to_wien, wien_to_bad_voeslau = get_direction_data(data)

        assert len(bad_voeslau_to_wien) == 0
        assert len(wien_to_bad_voeslau) == 0

    def test_get_direction_data_partial_keys(self):
        """Test extracting direction data with only one direction"""
        data = {
            "badVoeslauToWien": [{"ti": "10:17"}],
            "lastUpdated": "2025-07-27T08:11:19.908Z",
            # Missing wienToBadVoeslau
        }
        bad_voeslau_to_wien, wien_to_bad_voeslau = get_direction_data(data)

        assert len(bad_voeslau_to_wien) == 1
        assert len(wien_to_bad_voeslau) == 0


class TestDetermineTabOrder:
    """Tests for determine_tab_order function"""

    def test_morning_tab_order(self, mock_datetime_morning: datetime) -> None:
        """Test tab order in the morning (before 12:00)"""
        is_afternoon, tab_labels = determine_tab_order(mock_datetime_morning)

        assert is_afternoon is False
        assert tab_labels[0] == "🚂 Bad Vöslau → Wien Hbf"  # Work commute first
        assert tab_labels[1] == "🚂 Wien Hbf → Bad Vöslau"

    def test_afternoon_tab_order(self, mock_datetime_afternoon: datetime) -> None:
        """Test tab order in the afternoon (after 12:00)"""
        is_afternoon, tab_labels = determine_tab_order(mock_datetime_afternoon)

        assert is_afternoon is True
        assert tab_labels[0] == "🚂 Wien Hbf → Bad Vöslau"  # Homebound first
        assert tab_labels[1] == "🚂 Bad Vöslau → Wien Hbf"

    def test_noon_boundary(self, vienna_timezone: Any) -> None:
        """Test tab order exactly at noon"""
        noon_time = datetime(2025, 7, 27, 12, 0, 0, tzinfo=vienna_timezone)
        is_afternoon, tab_labels = determine_tab_order(noon_time)

        assert is_afternoon is True  # 12:00 is considered afternoon
        assert tab_labels[0] == "🚂 Wien Hbf → Bad Vöslau"

    def test_midnight_boundary(self, vienna_timezone: Any) -> None:
        """Test tab order at midnight"""
        midnight_time = datetime(2025, 7, 27, 0, 0, 0, tzinfo=vienna_timezone)
        is_afternoon, tab_labels = determine_tab_order(midnight_time)

        assert is_afternoon is False  # 00:00 is considered morning
        assert tab_labels[0] == "🚂 Bad Vöslau → Wien Hbf"

    def test_late_evening(self, vienna_timezone: Any) -> None:
        """Test tab order in late evening"""
        evening_time = datetime(2025, 7, 27, 23, 30, 0, tzinfo=vienna_timezone)
        is_afternoon, tab_labels = determine_tab_order(evening_time)

        assert is_afternoon is True  # Still afternoon logic
        assert tab_labels[0] == "🚂 Wien Hbf → Bad Vöslau"

    def test_default_current_time(self):
        """Test tab order with default current time (None parameter)"""
        # This should use current Vienna time
        is_afternoon, tab_labels = determine_tab_order(None)

        assert isinstance(is_afternoon, bool)
        assert len(tab_labels) == 2
        assert all("🚂" in label for label in tab_labels)
        assert any("Bad Vöslau → Wien Hbf" in label for label in tab_labels)
        assert any("Wien Hbf → Bad Vöslau" in label for label in tab_labels)


class TestCalculateDelayIntegration:
    """Integration tests for delay calculation in different contexts"""

    def test_delay_calculation_in_table_context(self):
        """Test delay calculation as used in create_train_table"""
        trains = [
            {
                "ti": "10:17",
                "rt": {"dlt": "10:19"},  # 2 minute delay
                "st": "Wien Hauptbahnhof",
                "pr": "REX 3",
                "tr": "1",
            },
            {
                "ti": "10:47",
                # No real-time data - should be on time
                "st": "Wien Hauptbahnhof",
                "pr": "REX 3",
                "tr": "2",
            },
        ]

        with patch("app.st") as mock_st:
            mock_st.warning = MagicMock()
            mock_st.dataframe = MagicMock()
            mock_st.column_config = MagicMock()
            mock_st.column_config.TextColumn = MagicMock()

            create_train_table(trains, "Test")

            call_args = mock_st.dataframe.call_args
            df = call_args[0][0]

            # First train should show delay
            assert df.iloc[0]["Delay (min)"] == "2"
            assert df.iloc[0]["Actual"] == "10:19"

            # Second train should show on time
            assert df.iloc[1]["Delay (min)"] == "—"
            assert df.iloc[1]["Actual"] == "✓ On time"

    def test_complex_delay_scenarios(self):
        """Test various complex delay scenarios"""
        test_cases = [
            ("10:17", "10:17", 0, "✓ On time"),  # Exactly on time
            ("10:17", "10:19", 2, "10:19"),  # 2 min delay
            ("10:17", "10:32", 15, "10:32"),  # 15 min delay
            ("09:58", "10:03", 5, "10:03"),  # Delay across hour
            (
                "10:17",
                "10:15",
                -2,
                "10:15",
            ),  # Early arrival (negative delay shows as no delay)
            (
                "23:58",
                "00:02",
                -1436,
                "00:02",
            ),  # Delay across midnight (negative due to simple time calc)
        ]

        for scheduled, actual, expected_delay, expected_actual in test_cases:
            trains = [
                {
                    "ti": scheduled,
                    "rt": {"dlt": actual} if actual != scheduled else None,
                    "st": "Wien Hauptbahnhof",
                    "pr": "REX 3",
                    "tr": "1",
                }
            ]

            with patch("app.st") as mock_st:
                mock_st.warning = MagicMock()
                mock_st.dataframe = MagicMock()
                mock_st.column_config = MagicMock()
                mock_st.column_config.TextColumn = MagicMock()

                create_train_table(trains, "Test")

                call_args = mock_st.dataframe.call_args
                df = call_args[0][0]

                # Check actual time display
                assert df.iloc[0]["Actual"] == expected_actual

                # Check delay display (only positive delays shown)
                if expected_delay > 0:
                    assert df.iloc[0]["Delay (min)"] == str(expected_delay)
                else:
                    assert df.iloc[0]["Delay (min)"] == "—"
