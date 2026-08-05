#!/usr/bin/env python3
"""Compatibility wrapper that improves AirNow handling without duplicating the main fetcher."""
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
    """Call AirNow while preserving the slash in application/json."""
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


def numeric_aqi(item: dict[str, Any]) -> float | None:
    value = item.get("AQI", item.get("aqi"))
    try:
        return float(value) if value not in (None, "") else None
    except (TypeError, ValueError):
        return None


def airnow_result(records: list[dict[str, Any]], source_type: str) -> dict[str, Any] | None:
    valid = [(item, numeric_aqi(item)) for item in records]
    valid = [(item, value) for item, value in valid if value is not None and value >= 0]
    if not valid:
        return None

    worst, worst_value = max(valid, key=lambda pair: pair[1])
    category_obj = worst.get("Category", worst.get("category"))
    category = category_obj.get("Name", category_obj.get("name")) if isinstance(category_obj, dict) else category_obj
    parameter = worst.get("ParameterName", worst.get("parameterName", worst.get("parameter")))
    reporting_area = worst.get("ReportingArea", worst.get("reportingArea"))
    value = int(round(worst_value))

    if source_type == "forecast":
        date_text = str(worst.get("DateForecast", worst.get("dateForecast", ""))).strip()
        note = f"Today's AirNow forecast · {parameter or 'AQI'} · {reporting_area or 'nearest reporting area'}"
        observed_at = date_text or None
    else:
        date_text = worst.get("DateObserved", worst.get("dateObserved"))
        hour_text = worst.get("HourObserved", worst.get("hourObserved"))
        timezone_text = worst.get("LocalTimeZone", worst.get("localTimeZone"))
        observed_at = f"{date_text} {hour_text}:00 {timezone_text}" if date_text is not None and hour_text is not None else None
        note = f"Current AirNow observation · {parameter or 'AQI'} · {reporting_area or 'nearest reporting area'}"

    return {
        "value": value,
        "category": str(category) if category else None,
        "parameter": parameter,
        "reporting_area": reporting_area,
        "observed_at": observed_at,
        "level": base.threshold_level(value, base.CONFIG["thresholds"]["aqi"]),
        "note": note,
        "configured": True,
        "source_type": source_type,
        "all_observations": [item for item, _ in valid],
    }


def fetch_airnow_v2() -> dict[str, Any] | None:
    key = os.getenv("AIRNOW_API_KEY", "").strip()
    if not key:
        base.AIRNOW_STATUS = {"configured": False, "note": "AIRNOW_API_KEY is not available to the workflow."}
        return None

    center = base.CONFIG["district"]["center"]
    common = {"format": "application/json", "distance": 25, "API_KEY": key}

    attempts = [
        ("https://www.airnowapi.org/aq/observation/latLong/current/", {**common, "latitude": center["lat"], "longitude": center["lon"]}),
        ("https://www.airnowapi.org/aq/observation/zipCode/current/", {**common, "zipCode": "92586"}),
    ]

    for endpoint, params in attempts:
        result = airnow_result(normalize_records(airnow_get(endpoint, params)), "observation")
        if result:
            base.AIRNOW_STATUS = {"configured": True, "note": result["note"]}
            return result

    forecast_params = {
        **common,
        "zipCode": "92586",
        "date": datetime.now(base.TZ).date().isoformat(),
    }
    forecast = airnow_result(
        normalize_records(airnow_get("https://www.airnowapi.org/aq/forecast/zipCode/", forecast_params)),
        "forecast",
    )
    if forecast:
        base.AIRNOW_STATUS = {"configured": True, "note": forecast["note"]}
        return forecast

    base.AIRNOW_STATUS = {
        "configured": True,
        "note": "AirNow key is configured, but neither a current observation nor today's reporting-area forecast was returned for Menifee.",
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
