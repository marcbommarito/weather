#!/usr/bin/env python3
"""Compatibility wrapper for the October 2026 AirNow API changes."""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from typing import Any

import fetch_weather as base


def airnow_get(endpoint: str, params: dict[str, Any], timeout: int = 25) -> Any | None:
    """Call AirNow and return decoded JSON."""
    query = urllib.parse.urlencode(dict(params), safe="/")
    request = urllib.request.Request(
        f"{endpoint}?{query}",
        headers={"User-Agent": base.USER_AGENT, "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        base.ERRORS.append(f"EPA AirNow: HTTP {exc.code} — {base._clean_response_snippet(detail)}")
        return None
    except (urllib.error.URLError, TimeoutError) as exc:
        base.ERRORS.append(f"EPA AirNow: temporarily unavailable — {getattr(exc, 'reason', exc)}")
        return None

    try:
        return json.loads(body)
    except json.JSONDecodeError:
        base.ERRORS.append(f"EPA AirNow: non-JSON response — {base._clean_response_snippet(body)}")
        return None


def normalize_records(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, dict)]
    if isinstance(payload, dict):
        for key in ("data", "Data", "observations", "Observations", "results", "Results"):
            value = payload.get(key)
            if isinstance(value, list):
                return [item for item in value if isinstance(item, dict)]
    return []


def first_value(item: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        if key in item and item[key] not in (None, ""):
            return item[key]
    return None


def numeric_aqi(item: dict[str, Any]) -> float | None:
    # October 2026 current-observation responses use nowcastAQI.
    # Forecast responses use aqi/Aqi; keep legacy AQI support as well.
    value = first_value(item, "nowcastAQI", "NowcastAQI", "AQI", "aqi", "Aqi")
    try:
        return float(value) if value not in (None, "") else None
    except (TypeError, ValueError):
        return None


def category_name(item: dict[str, Any]) -> str | None:
    value = first_value(
        item,
        "aqiCategoryName",
        "AqiCategoryName",
        "categoryName",
        "CategoryName",
    )
    if value not in (None, ""):
        return str(value)

    legacy = first_value(item, "Category", "category")
    if isinstance(legacy, dict):
        value = first_value(legacy, "Name", "name")
        return str(value) if value not in (None, "") else None
    if legacy not in (None, ""):
        return str(legacy)
    return None


def record_date(item: dict[str, Any]) -> str | None:
    value = first_value(
        item,
        "dateValid",
        "DateValid",
        "DateForecast",
        "dateForecast",
        "DateObserved",
        "dateObserved",
    )
    return str(value).strip() if value not in (None, "") else None


def observation_timestamp(item: dict[str, Any]) -> str | None:
    date_text = first_value(item, "dateObserved", "DateObserved")
    hour_text = first_value(item, "hourObserved", "HourObserved")
    timezone_text = first_value(item, "localTimeZone", "LocalTimeZone")

    if date_text is None:
        return None
    if hour_text is None:
        return str(date_text)

    hour = str(hour_text).strip()
    if ":" not in hour:
        hour = f"{hour}:00"
    suffix = f" {timezone_text}" if timezone_text not in (None, "") else ""
    return f"{date_text} {hour}{suffix}"


def airnow_result(records: list[dict[str, Any]], source_type: str) -> dict[str, Any] | None:
    if source_type == "forecast":
        today = datetime.now(base.TZ).date().isoformat()
        dated = [item for item in records if (record_date(item) or "").startswith(today)]
        if dated:
            records = dated

    valid = [(item, numeric_aqi(item)) for item in records]
    valid = [(item, value) for item, value in valid if value is not None and value >= 0]
    if not valid:
        return None

    worst, worst_value = max(valid, key=lambda pair: pair[1])
    category = category_name(worst)
    parameter = first_value(worst, "ParameterName", "parameterName", "parameter")
    reporting_area = first_value(
        worst,
        "ReportingArea",
        "reportingArea",
        "reportingAreaName",
        "ReportingAreaName",
    )
    site_name = first_value(worst, "siteName", "SiteName")
    value = int(round(worst_value))

    if source_type == "forecast":
        observed_at = record_date(worst)
        note = (
            f"Today's AirNow forecast · {parameter or 'AQI'} · "
            f"{reporting_area or 'nearest reporting area'}"
        )
    else:
        observed_at = observation_timestamp(worst)
        location_label = reporting_area or site_name or "nearest reporting area"
        note = f"Current AirNow observation · {parameter or 'AQI'} · {location_label}"

    return {
        "value": value,
        "category": category,
        "parameter": parameter,
        "reporting_area": reporting_area,
        "site_name": site_name,
        "observed_at": observed_at,
        "level": base.threshold_level(value, base.CONFIG["thresholds"]["aqi"]),
        "note": note,
        "configured": True,
        "source_type": source_type,
        "all_observations": [item for item, _ in valid],
    }


def fetch_airnow_v2() -> dict[str, Any] | None:
    """Use the AirNow web services that replaced the retired endpoints on Oct. 1, 2026."""
    key = os.getenv("AIRNOW_API_KEY", "").strip()
    if not key:
        base.AIRNOW_STATUS = {
            "configured": False,
            "note": "AIRNOW_API_KEY is not available to the workflow.",
        }
        return None

    center = base.CONFIG["district"]["center"]
    json_common = {"format": "application/json", "API_KEY": key}

    # Retired Sept. 30, 2026:
    #   /aq/observation/latLong/current/
    #   /aq/observation/zipCode/current/
    # Replacement service handles either coordinates or ZIP.
    observation_endpoint = "https://www.airnowapi.org/aq/observation/current/ziplatlong/"
    observation_attempts = [
        {
            **json_common,
            "latitude": center["lat"],
            "longitude": center["lon"],
        },
        {
            **json_common,
            # The replacement observation service documents this field as lowercase.
            "zipcode": "92586",
        },
    ]

    for params in observation_attempts:
        payload = airnow_get(observation_endpoint, params)
        result = airnow_result(normalize_records(payload), "observation")
        if result:
            base.AIRNOW_STATUS = {"configured": True, "note": result["note"]}
            return result

    # Retired Sept. 30, 2026:
    #   /aq/forecast/zipCode/
    #   /aq/forecast/latLong/
    # Replacement current-forecast service supports either coordinates or ZIP.
    forecast_endpoint = "https://www.airnowapi.org/aq/forecast/current/"
    forecast_attempts = [
        {
            **json_common,
            "latitude": center["lat"],
            "longitude": center["lon"],
        },
        {
            **json_common,
            "zipCode": "92586",
        },
    ]

    for params in forecast_attempts:
        payload = airnow_get(forecast_endpoint, params)
        result = airnow_result(normalize_records(payload), "forecast")
        if result:
            base.AIRNOW_STATUS = {"configured": True, "note": result["note"]}
            return result

    base.AIRNOW_STATUS = {
        "configured": True,
        "note": (
            "AirNow key is configured, but the replacement October 2026 services "
            "returned neither a current observation nor today's reporting-area forecast for Menifee."
        ),
    }
    return None


_original_fetch_cimis = base.fetch_cimis


def fetch_cimis_quiet() -> list[dict[str, Any]]:
    before = len(base.ERRORS)
    result = _original_fetch_cimis()
    new_errors = base.ERRORS[before:]
    base.ERRORS[before:] = [
        message for message in new_errors
        if not (message.startswith("CIMIS:") and "timed out" in message.lower())
    ]
    return result


base.fetch_airnow = fetch_airnow_v2
base.fetch_cimis = fetch_cimis_quiet

if __name__ == "__main__":
    raise SystemExit(base.main())
