"""Tests for edge cases and error handling scenarios"""

import json
from datetime import datetime
from typing import Any
from unittest.mock import MagicMock, mock_open, patch

from app import (
    calculate_delay,
    determine_tab_order,
    format_last_updated_display,
    format_time,
    get_direction_data,
    is_data_stale,
    load_departures_data,
    should_auto_refresh,
)


class TestEdgeCasesLoadDeparturesData:
    """Edge case tests for load_departures_data function"""

    def test_file_permission_error(self):
        """Test handling file permission errors"""
        with patch('app.os.path.exists', return_value=True), \
             patch('builtins.open', side_effect=PermissionError("Permission denied")):
            result = load_departures_data()
            assert result is None

    def test_json_decode_error(self):
        """Test handling JSON decode errors"""
        invalid_json = '{"badVoeslauToWien": [invalid json'
        
        with patch('app.os.path.exists', return_value=True), \
             patch('builtins.open', mock_open(read_data=invalid_json)):
            result = load_departures_data()
            assert result is None

    def test_unicode_decode_error(self):
        """Test handling Unicode decode errors"""
        with patch('app.os.path.exists', return_value=True), \
             patch('builtins.open', side_effect=UnicodeDecodeError("utf-8", b"", 0, 1, "invalid")):
            result = load_departures_data()
            assert result is None

    def test_empty_file(self):
        """Test handling empty JSON file"""
        with patch('app.os.path.exists', return_value=True), \
             patch('builtins.open', mock_open(read_data="")):
            result = load_departures_data()
            assert result is None

    def test_null_json_content(self):
        """Test handling null JSON content"""
        with patch('app.os.path.exists', return_value=True), \
             patch('builtins.open', mock_open(read_data="null")):
            result = load_departures_data()
            assert result is None

    def test_non_dict_json_content(self):
        """Test handling non-dictionary JSON content"""
        non_dict_json = '["not", "a", "dictionary"]'
        
        with patch('app.os.path.exists', return_value=True), \
             patch('builtins.open', mock_open(read_data=non_dict_json)):
            result = load_departures_data()
            # Will fail because code expects dict, tries to access .get() method
            assert result is None

    def test_very_large_file(self):
        """Test handling very large JSON files"""
        # Create a large dataset
        large_data = {
            "badVoeslauToWien": [{"ti": f"{i:02d}:{i%60:02d}"} for i in range(1000)],
            "wienToBadVoeslau": [],
            "lastUpdated": "2025-07-27T08:11:19.908Z",
            "stations": {}
        }
        
        with patch('app.os.path.exists', return_value=True), \
             patch('builtins.open', mock_open(read_data=json.dumps(large_data))):
            result = load_departures_data()
            assert result is not None
            assert len(result["badVoeslauToWien"]) == 1000

    def test_corrupted_old_format_data(self):
        """Test handling corrupted old format data"""
        corrupted_old_data = {
            "journey": "not a list",  # Should be a list
            "lastUpdated": "2025-07-27T08:11:19.908Z",
            "station": {"name": "Bad Vöslau"}
        }
        
        with patch('app.os.path.exists', return_value=True), \
             patch('builtins.open', mock_open(read_data=json.dumps(corrupted_old_data))):
            result = load_departures_data()
            assert result is not None
            # Should still convert, even with corrupted journey data
            assert "badVoeslauToWien" in result


class TestEdgeCasesTimeHandling:
    """Edge case tests for time handling functions"""

    def test_format_time_extreme_values(self):
        """Test format_time with extreme values"""
        assert format_time("00:00") == "00:00"
        assert format_time("23:59") == "23:59"
        assert format_time("24:00") == "24:00"  # Invalid but should pass through
        assert format_time("99:99") == "99:99"  # Invalid but should pass through

    def test_format_time_unusual_formats(self):
        """Test format_time with unusual formats"""
        assert format_time("1:30") == "1:30"     # Single digit hour
        assert format_time("10:5") == "10:5"     # Single digit minute
        assert format_time("10:30:45") == "10:30:45"  # With seconds
        assert format_time("invalid") == "invalid"     # Invalid format

    def test_calculate_delay_edge_cases(self):
        """Test calculate_delay with edge cases"""
        # Time wraparound (assuming same day) - function doesn't handle midnight wraparound
        assert calculate_delay("23:59", "00:01") == -1438  # Negative delay (early arrival)
        assert calculate_delay("00:01", "23:59") == 1438   # Large positive delay
        
        # Invalid time formats - function doesn't validate time ranges, just converts
        # So 25:70 becomes 25*60 + 70 = 1570 minutes, 10:30 becomes 630 minutes  
        # Result is 630 - 1570 = -940 minutes
        assert calculate_delay("25:70", "10:30") == -940  # Invalid but calculated
        assert calculate_delay("10:30", "25:70") == 940   # Invalid but calculated
        assert calculate_delay("ab:cd", "ef:gh") == 0     # Truly invalid, returns 0
        
        # Empty strings
        assert calculate_delay("", "10:30") == 0
        assert calculate_delay("10:30", "") == 0
        assert calculate_delay("", "") == 0

    def test_calculate_delay_single_digit_times(self):
        """Test calculate_delay with single digit times"""
        assert calculate_delay("9:05", "9:07") == 2
        assert calculate_delay("10:5", "10:7") == 2
        assert calculate_delay("9:5", "10:7") == 62

    def test_is_data_stale_timezone_edge_cases(self):
        """Test is_data_stale with timezone edge cases"""
        # Test with different timezone formats
        data_utc = {"lastUpdated": "2025-07-27T08:11:19Z"}
        data_offset = {"lastUpdated": "2025-07-27T08:11:19+00:00"}
        data_cet = {"lastUpdated": "2025-07-27T10:11:19+02:00"}
        
        # All should be processed correctly
        assert isinstance(is_data_stale(data_utc, 60), bool)
        assert isinstance(is_data_stale(data_offset, 60), bool)
        assert isinstance(is_data_stale(data_cet, 60), bool)

    def test_format_last_updated_extreme_dates(self):
        """Test format_last_updated_display with extreme dates"""
        # Very old date
        old_date = "1970-01-01T00:00:00Z"
        result = format_last_updated_display(old_date)
        assert result is not None
        assert ":" in result
        
        # Far future date
        future_date = "2099-12-31T23:59:59Z"
        result = format_last_updated_display(future_date)
        assert result is not None
        assert ":" in result

    def test_format_last_updated_microseconds(self):
        """Test format_last_updated_display with microseconds"""
        timestamp_with_microseconds = "2025-07-27T08:11:19.123456Z"
        result = format_last_updated_display(timestamp_with_microseconds)
        assert result is not None
        assert ":" in result
        assert len(result) == 8  # Should still be HH:MM:SS


class TestEdgeCasesDataStructures:
    """Edge case tests for data structure handling"""

    def test_get_direction_data_malformed_structure(self):
        """Test get_direction_data with malformed data structures"""
        # Non-list values
        malformed_data = {
            "badVoeslauToWien": "not a list",
            "wienToBadVoeslau": {"not": "a list"},
            "lastUpdated": "2025-07-27T08:11:19.908Z"
        }
        
        bad_voeslau, wien = get_direction_data(malformed_data)
        assert bad_voeslau == "not a list"  # Should return whatever is there
        assert wien == {"not": "a list"}

    def test_get_direction_data_missing_all_keys(self):
        """Test get_direction_data with completely empty dict"""
        empty_data = {}
        bad_voeslau, wien = get_direction_data(empty_data)
        assert bad_voeslau == []
        assert wien == []

    def test_determine_tab_order_invalid_datetime(self):
        """Test determine_tab_order with invalid datetime objects"""
        # Test with timezone-naive datetime
        naive_dt = datetime(2025, 7, 27, 15, 30, 0)  # No timezone
        is_afternoon, tabs = determine_tab_order(naive_dt)
        assert isinstance(is_afternoon, bool)
        assert len(tabs) == 2

    def test_should_auto_refresh_edge_cases(self):
        """Test should_auto_refresh with edge case data"""
        # Empty dict - should be stale (no timestamp)
        assert should_auto_refresh({}, 60) is True
        
        # Dict with wrong structure - should be stale (no valid timestamp)
        wrong_structure = {"not": "the right", "structure": True}
        assert should_auto_refresh(wrong_structure, 60) is True  # No timestamp = stale


class TestEdgeCasesStreamlitIntegration:
    """Edge case tests for Streamlit integration points"""

    def test_create_train_table_malformed_trains(self):
        """Test create_train_table with malformed train data"""
        malformed_trains = [
            {},  # Empty train dict
            {"ti": None},  # Null departure time
            {"ti": "10:17", "pr": None, "tr": None},  # Null values
            {"not_standard_keys": "values"},  # Wrong keys
            None  # Null train object
        ]
        
        from app import create_train_table
        
        with patch('app.st') as mock_st:
            mock_st.warning = MagicMock()
            mock_st.dataframe = MagicMock()
            mock_st.column_config = MagicMock()
            mock_st.column_config.TextColumn = MagicMock()
            
            # Should not crash
            create_train_table(malformed_trains, "Test Direction")
            
            # Should create dataframe (even with malformed data)
            mock_st.dataframe.assert_called_once()

    def test_create_train_table_large_dataset(self):
        """Test create_train_table with very large dataset"""
        large_trains = []
        for i in range(100):  # 100 trains
            large_trains.append({
                "ti": f"{i%24:02d}:{i%60:02d}",
                "st": f"Wien Station {i}",
                "pr": f"Train {i}",
                "tr": str(i % 10),
                "rt": {"dlt": f"{i%24:02d}:{(i+5)%60:02d}"} if i % 3 == 0 else None
            })
        
        from app import create_train_table
        
        with patch('app.st') as mock_st:
            mock_st.warning = MagicMock()
            mock_st.dataframe = MagicMock()
            mock_st.column_config = MagicMock()
            mock_st.column_config.TextColumn = MagicMock()
            
            create_train_table(large_trains, "Test Direction")
            
            mock_st.dataframe.assert_called_once()
            call_args = mock_st.dataframe.call_args
            df = call_args[0][0]
            
            assert len(df) == 100


class TestErrorRecoveryScenarios:
    """Tests for error recovery scenarios"""

    def test_partial_data_corruption(self):
        """Test handling when only part of the data is corrupted"""
        partially_corrupted = {
            "badVoeslauToWien": [
                {"ti": "10:17", "st": "Wien Hauptbahnhof", "pr": "REX 3", "tr": "1"},  # Valid
                {"ti": None, "st": None},  # Partially corrupted
                {"completely": "wrong structure"},  # Wrong structure
                {"ti": "10:47", "st": "Wien Hauptbahnhof", "pr": "REX 3", "tr": "2"}   # Valid
            ],
            "wienToBadVoeslau": "corrupted - should be list",  # Wrong type
            "lastUpdated": "2025-07-27T08:11:19.908Z",
            "stations": {}
        }
        
        with patch('app.os.path.exists', return_value=True), \
             patch('builtins.open', mock_open(read_data=json.dumps(partially_corrupted))):
            
            data = load_departures_data()
            assert data is not None
            
            # Should still be able to extract what data is valid
            bad_voeslau, wien = get_direction_data(data)
            assert len(bad_voeslau) == 4  # All items, even corrupted ones
            assert wien == "corrupted - should be list"  # Returns whatever is there

    def test_memory_pressure_simulation(self):
        """Test behavior under simulated memory pressure"""
        # Create very large nested data structure
        memory_intensive_data = {
            "badVoeslauToWien": [
                {
                    "ti": "10:17",
                    "large_field": "x" * 10000,  # 10KB string
                    "nested": {"deep": {"very": {"deep": ["data"] * 100}}}
                } for _ in range(10)  # 10 large entries
            ],
            "wienToBadVoeslau": [],
            "lastUpdated": "2025-07-27T08:11:19.908Z",
            "stations": {}
        }
        
        with patch('app.os.path.exists', return_value=True), \
             patch('builtins.open', mock_open(read_data=json.dumps(memory_intensive_data))):
            
            # Should handle large data without crashing
            data = load_departures_data()
            assert data is not None
            assert len(data["badVoeslauToWien"]) == 10

    def test_concurrent_access_simulation(self):
        """Test behavior when file is being written while reading"""
        # Simulate file being modified during read (race condition)
        def side_effect_incomplete_read(*args: Any, **kwargs: Any) -> Any:
            # Return incomplete JSON (as if file was truncated during read)
            return mock_open(read_data='{"badVoeslauToWien": [{"ti": "10:17"')(*args, **kwargs)
        
        with patch('app.os.path.exists', return_value=True), \
             patch('builtins.open', side_effect=side_effect_incomplete_read):
            
            result = load_departures_data()
            assert result is None  # Should handle gracefully

    def test_system_resource_errors(self):
        """Test handling of system resource errors"""
        # Test various system-level errors
        system_errors = [
            OSError("No space left on device"),
            MemoryError("Out of memory"),
            IOError("I/O operation failed"),
        ]
        
        for error in system_errors:
            with patch('app.os.path.exists', return_value=True), \
                 patch('builtins.open', side_effect=error):
                
                result = load_departures_data()
                assert result is None  # Should handle all system errors gracefully