#!/usr/bin/env python3
"""Final weather fetch wrapper with corrected CIMIS record selection."""
from __future__ import annotations

import json
import os
import re
from datetime import datetime, timedelta, timezone
from typing import Any

import fetch_weather as base
import fetch_weather_v2 as airnow_patch  # noqa: F401 - applies AirNow patch


CIMIS_ALIASES: dict[str, list[str]] = {
    "temperature_f": [
        "HlyAirTmp", "HlyAirTemp", "hly-air-tmp", "AirTmp",
        "AirTemp", "AirTemperature", "HourlyAirTemperature",
    ],
    "dewpoint_f": [
        "HlyDewPnt", "HlyDewPoint", "hly-dew-pnt", "DewPoint",
        "DewPnt", "HourlyDewPoint",
    ],
    "relative_humidity_pct": [
        "HlyRelHum", "hly-rel-hum", "RelHum", "RelativeHumidity",
        "HourlyRelativeHumidity",
    ],
    "wind_direction_deg": [
        "HlyWindDir", "hly-wind-dir", "WindDir", "WindDirection",
        "HourlyWindDirection",
    ],
    "wind_speed_mph": [
        "HlyWindSpd", "hly-wind-spd", "WindSpd", "WindSpeed",
        "HourlyWindSpeed",
    ],
    "precip_last_hour_in": [
        "HlyPrecip", "hly-precip", "Precip", "Precipitation",
        "HourlyPrecipitation",
    ],
}


def measurements(record: dict[str, Any]) -> dict[str, float | None]:
    return {
        field: base.find_nested_numeric(record, aliases)
        for field, aliases in CIMIS_ALIASES.items()
    }


def fetch_cimis_v3() -> list[dict[str, Any]]:
    """Use the newest non-future CIMIS row that has at least one measurement."""
    station_defs = base.CONFIG["stations"]["cimis"]
    if not station_defs:
        return []

    key = os.environ.get("CIMIS_APP_KEY", "").strip()
    if not key:
        base.ERRORS.append(
            "CIMIS: CIMIS_APP_KEY is not configured in the GitHub Actions environment."
        )
        return []

    cimis_tz = timezone(timedelta(hours=-8))
    local_now = datetime.now(cimis_tz)
    endpoint = "https://et.water.ca.gov/StationWeb/GetDataByStationNumber"
    params = {
        "stationNbrs": ",".join(str(item["id"]) for item in station_defs),
        "startDate": (local_now.date() - timedelta(days=1)).isoformat(),
        "endDate": local_now.date().isoformat(),
        "isHourly": "true",
        "unitOfMeasure": "E",
        "dataItems": (
            "hly-air-tmp,hly-dew-pnt,hly-precip,hly-rel-hum,"
            "hly-wind-dir,hly-wind-spd"
        ),
    }

    before = len(base.ERRORS)
    payload = base.safe_get(
        "CIMIS",
        endpoint,
        params,
        accept="application/json",
        extra_headers={"Ocp-Apim-Subscription-Key": key},
        timeout=45,
        attempts=3,
        retry_delay_seconds=3,
    )
    new_errors = base.ERRORS[before:]
    base.ERRORS[before:] = [
        message for message in new_errors
        if not (message.startswith("CIMIS:") and "timed out" in message.lower())
    ]
    if payload is None:
        return []

    records = base.flatten_records(payload)
    result: list[dict[str, Any]] = []
    future_limit = base.now_utc() + timedelta(minutes=15)

    for station in station_defs:
        station_id = re.sub(r"\D", "", str(station["id"]))
        candidates: list[tuple[datetime, str, dict[str, float | None]]] = []

        for record in records:
            station_text = base.find_nested_text(
                record,
                ["StationNbr", "StationNr", "StationNumber", "StationId", "Station"],
            )
            if station_text is None or re.sub(r"\D", "", station_text) != station_id:
                continue

            observed_at = base.cimis_record_datetime_utc(record)
            observed_dt = base.parse_dt(observed_at)
            values = measurements(record)
            if (
                observed_dt is None
                or observed_dt > future_limit
                or all(value is None for value in values.values())
            ):
                continue
            candidates.append((observed_dt, observed_at, values))

        if not candidates:
            continue

        _, observed_at, values = max(candidates, key=lambda item: item[0])
        age = base.age_minutes(observed_at)
        temperature = values["temperature_f"]
        humidity = values["relative_humidity_pct"]
        result.append({
            "id": str(station["id"]),
            "name": station["name"],
            "network": "California DWR CIMIS",
            "lat": station["lat"],
            "lon": station["lon"],
            "observed_at": observed_at,
            "age_minutes": age,
            "stale": age is None or age > base.CONFIG["thresholds"]["stationStaleMinutes"],
            "condition": "Hourly CIMIS station observation",
            "temperature_f": temperature,
            "dewpoint_f": values["dewpoint_f"],
            "relative_humidity_pct": humidity,
            "heat_index_f": base.heat_index_fahrenheit(temperature, humidity),
            "wind_chill_f": None,
            "wind_direction_deg": values["wind_direction_deg"],
            "wind_speed_mph": values["wind_speed_mph"],
            "wind_gust_mph": None,
            "visibility_miles": None,
            "pressure_inhg": None,
            "precip_last_hour_in": values["precip_last_hour_in"],
            "raw_message": None,
            "source_url": endpoint,
        })

    print(
        f"CIMIS usable stations: {len(result)} of {len(station_defs)} "
        f"({len(records)} response records inspected)"
    )
    return result


def improve_coverage() -> None:
    path = base.OUTPUT_PATH
    if not path.exists():
        return
    data = json.loads(path.read_text(encoding="utf-8"))
    stations = data.get("stations", [])

    nws = [s for s in stations if s.get("network") == "NWS / aviation"]
    nws_current = [s for s in nws if not s.get("stale")]
    nws_stale = [s for s in nws if s.get("stale")]
    cimis = [s for s in stations if s.get("network") == "California DWR CIMIS"]
    cimis_current = [s for s in cimis if not s.get("stale")]

    for item in data.get("coverage", []):
        if item.get("name") == "National Weather Service stations":
            item["status"] = "available" if nws_current else "partial"
            item["detail"] = (
                f"{len(nws_current)} current and {len(nws_stale)} stale of "
                f"{len(base.CONFIG['stations']['nws'])} configured station feeds."
            )
        elif item.get("name") == "California DWR CIMIS":
            item["status"] = "available" if cimis_current else "partial"
            item["detail"] = (
                f"{len(cimis_current)} current usable station feed(s) loaded."
                if cimis_current
                else "The API responded, but no non-future hourly rows contained usable measurements."
            )
        elif item.get("name") == "Personal weather stations":
            item["detail"] = "Reference locations only; no live personal-station API is connected."

    path.write_text(json.dumps(data, indent=2), encoding="utf-8")


base.fetch_cimis = fetch_cimis_v3

if __name__ == "__main__":
    code = base.main()
    improve_coverage()
    raise SystemExit(code)
